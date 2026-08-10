const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WebLink = require("../models/weblink-images.js");
const OrderModel = require("../models/order.js")
const { sendWhatsApp } = require('../utils/whatsappservice.js');

const {
  generateThumbnail,
  resizeImage,
  uploadFileToS3,
  generateVideoPreview,
  deleteFileWithRetry,
  getVideoDuration
} = require("../utils/auth.util.js");
const apiKey = process.env.GOOGLE_DRIVE_API_KEY;



function getFolderIdFromUrl(url) {
  const regex = /\/folders\/([a-zA-Z0-9_-]+)(\?.*)?$/;
  const match = url.match(regex);
  return match ? match[1] : null;
}
async function isFolderPubliclyAccessible(folderId, apiKey) {
  try {
    const metadataUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=permissions&key=${apiKey}`;
    const response = await axios.get(metadataUrl);
    const permissions = response.data.permissions || [];

    if (
      permissions.some(
        (perm) =>
          perm.type === "anyone" &&
          (perm.role === "viewer" ||
            perm.role === "reader" ||
            perm.role === "writer")
      )
    ) {
      return true;
    }

    // Fallback test
    const testUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false&key=${apiKey}&fields=files(id)`;
    await axios.get(testUrl);
    return true;
  } catch (error) {
    return false;
  }
}
async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.log("ERROR DOWNLOADING DRIVE ................", error, "URL....... :", url, "DESTINATION .........", dest)
    throw error;
  }
}

async function getTotalDriveFiles(folderId) {
  let pageToken = null;
  let total = 0;

  do {
    let url = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')&key=${apiKey}&fields=nextPageToken,files(id)&pageSize=1000`;

    if (pageToken) {
      url += `&pageToken=${pageToken}`;
    }

    const res = await axios.get(url);

    const files = res.data.files || [];

    total += files.length;

    console.log("COUNT BATCH:", files.length);
    console.log("TOTAL COUNT:", total);

    pageToken = res.data.nextPageToken;

  } while (pageToken);

  return total;
}

let driveCountQueue = Promise.resolve();


async function getDriveCountSequentially(folderId, orderId) {

  return new Promise((resolve, reject) => {

    driveCountQueue = driveCountQueue
      .catch(() => { })
      .then(async () => {

        console.log("STARTING COUNT FOR:", folderId, "ORDER ID", orderId);

        const startTime = Date.now();

        const count = await getTotalDriveFiles(folderId);

        const endTime = Date.now();

        console.log("COUNT FINISHED FOR:", folderId, "ORDER ID:", orderId, "TOTAL TIME:", `${((endTime - startTime) / 1000).toFixed(2)} sec`);

        console.log("COUNT FINISHED FOR:", folderId, "ORDER ID", orderId);

        resolve(count);

      })
      .catch(reject);

  });

}

async function handleDriveFolderUpload(
  folderUrl,
  vendorId,
  phoneNo,
  customerId,
  orderId,
  mainFolderId
) {

  //retry file arrray
  let failedFiles = [];

  let failCount = 0;

  console.log("mainFolderId in the handler", mainFolderId)
  console.log("START PROCESSING FIRST ONE FOR THIS ORDER II ------------>>>>>>>>>>", orderId);
  const folderId = getFolderIdFromUrl(folderUrl);
  if (!folderId) throw new Error("Invalid Google Drive folder URL");
  if (!apiKey) throw new Error("Google Drive API key not configured");

  const isPublic = await isFolderPubliclyAccessible(folderId, apiKey);
  if (!isPublic) {
    throw new Error("Google Drive folder link is not publicly accessible");
  }

  const folderName = `${orderId}_${customerId}_${phoneNo}`;
  const orderByName = phoneNo || "";

  const tempDir = path.join(__dirname, "tempUploads");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });


  const totalDriveFiles = await getDriveCountSequentially(folderId, orderId);


  console.log("TOTAL FILES IN DRIVE =====", totalDriveFiles);

  await OrderModel.findOneAndUpdate(
    { order_id: orderId },
    {
      $set: {
        "imageUploadCounts.totalFromDrive": totalDriveFiles
      }
    }
  );


  const folderPath = folderName;
  async function processFile(file, retryCount = 0) {
    let filePath, thumbnailPath, clipPath;
    try {
      const originalName = file.name;
      const driveFileId = file.id;
      const ext = path.extname(originalName) || "";
      const fileName = `${driveFileId}${ext}`;
      filePath = path.join(tempDir, fileName);

      const existingFile = await WebLink.findOne({
        driveFileId,
        orderId: orderId.toString()
      });


      // already uploaded
      if (existingFile?.status === "done") {

        console.log(`⏩ FILE ALREADY DONE: ${file.id}`);

        return {
          skipped: true,
          fileName: file.name
        };
      }


      // already processing
      if (existingFile?.status === "uploading") {

        console.log(`⏩ FILE ALREADY PROCESSING: ${file.id}`);

        return {
          skipped: true,
          fileName: file.name
        };
      }


      // retry failed file
      // retry failed file
      if (existingFile?.status === "failed") {

        console.log(`🔄 RETRYING FAILED FILE: ${file.id}`);

        await WebLink.updateOne(
          {
            driveFileId,
            orderId: orderId.toString()
          },
          {
            $set: {
              status: "uploading"
            }
          }
        );
      }
      else {

        // new file
        await WebLink.findOneAndUpdate(
          {
            driveFileId,
            orderId: orderId.toString()
          },
          {
            $setOnInsert: {
              driveFileId,
              orderId: orderId.toString(),
              mainFolderId,
              status: "uploading",
              retryCount: 0,

            }
          },
          {
            upsert: true,
            new: true
          }
        );

        console.log(`PLACEHOLDER CREATED: ${driveFileId}`);
      }


      const downloadUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
      console.log(`⬇️ STEP 1 DOWNLOAD STARTED: ${originalName} | Batch: ${file.batch}`);

      await downloadFile(downloadUrl, filePath);

      console.log(`✅ STEP 2   DOWNLOAD COMPLETED: ${originalName} | Batch: ${file.batch}`);

      const isImage = file.mimeType.startsWith("image/");
      const isVideo = file.mimeType.startsWith("video/") || file.name.match(/\.(mp4|mov|mkv|webm)$/i);

      // ================= IMAGE =================
      if (isImage) {
        let path1080, path2160;
        try {
          // File Paths for all variations
          thumbnailPath = path.join(tempDir, `thumb_${driveFileId}.webp`);
          path1080 = path.join(tempDir, `1080_${driveFileId}.jpg`);
          path2160 = path.join(tempDir, `2160_${driveFileId}.jpg`);

          const fileName1080 = `1080_${driveFileId}.jpeg`;
          const fileName2160 = `2160_${driveFileId}.jpeg`;
          const thumbFileName = `thumb_${driveFileId}.webp`;

          console.log("STEP 3 GENERATING ALL IMAGE VARIATIONS START", file.name);

          // 1. Generate Thumbnail (WebP)
          const genThumb = generateThumbnail(filePath, thumbnailPath);

          // 2. Generate 1080px Width (JPEG, Auto Height)
          const gen1080 = resizeImage(filePath, path1080, 1080);

          // 3. Generate 2160px Width (JPEG, Auto Height)
          const gen2160 = resizeImage(filePath, path2160, 2160);

          // Run image processing in parallel
          await Promise.all([genThumb, gen1080, gen2160]);

          console.log("STEP 4 VARIATIONS GENERATED SUCCESSFULLY", file.name);

          console.log("STEP 5 S3 UPLOAD START FOR ALL 4 VARIATIONS", file.name);

          // Parallel Upload to S3
          const uploadOriginal = uploadFileToS3(
            filePath,
            fileName,
            folderPath,
            phoneNo,
            file.mimeType || "image/jpeg"
          );

          const uploadThumb = uploadFileToS3(
            thumbnailPath,
            thumbFileName,
            folderPath,
            phoneNo,
            "image/webp"
          );

          const upload1080 = uploadFileToS3(
            path1080,
            fileName1080,
            folderPath,
            phoneNo,
            "image/jpeg"
          );

          const upload2160 = uploadFileToS3(
            path2160,
            fileName2160,
            folderPath,
            phoneNo,
            "image/jpeg"
          );

          // Wait for all 4 uploads to finish
          const [original, thumb, res1080, res2160] = await Promise.all([
            uploadOriginal,
            uploadThumb,
            upload1080,
            upload2160
          ]);

          console.log("STEP 6 ALL 4 S3 UPLOADS COMPLETE", file.name);

          console.log("STEP 7 DB INSERT START", file.name);

          try {
            const result = await WebLink.updateOne(
              {
                driveFileId,
                orderId: orderId.toString()
              },
              {
                $set: {
                  driveFileId,
                  orderId: orderId.toString(),

                  orderById: customerId,
                  orderByName,

                  type: "image",

                  originalUrl: original?.Location,
                  originalKey: original?.Key,

                  thumbnailImageUrl: thumb?.Location || null,
                  thumbnailKey: thumb?.Key || null,

                  // New Resized Image URLs & Keys
                  imageUrl1080: res1080?.Location || null,
                  imageKey1080: res1080?.Key || null,

                  imageUrl2160: res2160?.Location || null,
                  imageKey2160: res2160?.Key || null,

                  videoClipUrl: null,
                  videoClipKey: null,

                  mainFolderId,

                  status: "done",
                }
              },
              { upsert: false, new: true, rawResult: true }
            );

            console.log("INSERTED DOC =====", result);

          } catch (error) {
            console.log('create document error ------- image -------', error);
            throw error;
          }
          console.log("STEP 8 DB INSERT DONE", file.name);

          // Cleanup Temp Files
          if (filePath && fs.existsSync(filePath)) {
            await deleteFileWithRetry(filePath);
          }
          if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            await deleteFileWithRetry(thumbnailPath);
          }
          if (path1080 && fs.existsSync(path1080)) {
            await deleteFileWithRetry(path1080);
          }
          if (path2160 && fs.existsSync(path2160)) {
            await deleteFileWithRetry(path2160);
          }

          return { type: "image", fileName: originalName };
        }
        catch (error) {
          // Cleanup on Failure
          if (filePath && fs.existsSync(filePath)) await deleteFileWithRetry(filePath).catch(() => { });
          if (thumbnailPath && fs.existsSync(thumbnailPath)) await deleteFileWithRetry(thumbnailPath).catch(() => { });
          if (path1080 && fs.existsSync(path1080)) await deleteFileWithRetry(path1080).catch(() => { });
          if (path2160 && fs.existsSync(path2160)) await deleteFileWithRetry(path2160).catch(() => { });

          console.log('image upload error', error);
          throw error;
        }
      }

      // ================= VIDEO =================
      if (isVideo) {
        clipPath = path.join(tempDir, `clip_${driveFileId}.mp4`);

        try {
          console.log("STEP 3 GENERATE PREVIEW CLIP START", file.name)

          await generateVideoPreview(filePath, clipPath, 3);

          const durationVal = await getVideoDuration(filePath);

          console.log("STEP 4 VIDEO PREVIEW GENERATION COMPLETE", file.name)

          console.log("STEP 5 VIDEO S3 UPLOAD VIDEO START", file.name)


          const uploadVideo = uploadFileToS3(
            filePath,
            fileName,
            folderPath,
            phoneNo,
            file.mimeType
          );

          const uploadClip = uploadFileToS3(
            clipPath,
            path.basename(clipPath),
            folderPath,
            phoneNo,
            "video/mp4"
          );
          console.log("STEP 6 VIDEO S3 UPLOAD COMPLETE", file.name)
          console.log("STEP 7 VIDEO DB INSERT START", file.name)

          const [video, clip] = await Promise.all([uploadVideo, uploadClip]);
          try {

            const result = await WebLink.updateOne(
              {
                driveFileId,
                orderId: orderId.toString()
              },
              {
                $set: {
                  driveFileId,
                  orderId: orderId.toString(),

                  orderById: customerId,
                  orderByName,

                  type: "video",

                  originalUrl: video?.Location,
                  originalKey: video?.Key,

                  thumbnailImageUrl: null,
                  thumbnailKey: null,

                  videoClipUrl: clip?.Location || null,
                  videoClipKey: clip?.Key || null,
                  duration: durationVal,

                  mainFolderId,

                  status: "done",
                }
              },
              { upsert: false, new: true, rawResult: true }
            );


          } catch (error) {
            console.log('create documnet error ------- video -------', error);
            throw error;
          }
          console.log("STEP 8 VIDEO DB INSERT DONE", file.name)


          if (filePath && fs.existsSync(filePath)) {
            console.log("DELETE VIDEO START");
            await deleteFileWithRetry(filePath);
          }

          if (clipPath && fs.existsSync(clipPath)) {
            console.log("DELETE CLIP START");
            await deleteFileWithRetry(clipPath);
          }

          return { type: "video", fileName: originalName };
        }
        catch (error) {
          console.log('video upload error', error); throw error;
        }
      }
    }
    // catch (err) {
    //   console.error(`Error processing ------------ ${file?.name}:`, err.message);
    //   failCount++;
    //   return { fileName: file?.name, error: err.message };
    // } 
    catch (err) {
      console.error(`Error processing ------------------- ${file?.name}: 
    failedFiles ARRAY  : ${failedFiles}
    `, err.message);
      console.log(`Retry Count: ${retryCount}`);


      await WebLink.updateOne(
        {
          driveFileId: file?.id,
          orderId: orderId.toString(),
          mainFolderId
        },
        {
          $set: {
            status: "failed"
          },
          $inc: {
            retryCount: 1
          }
        }
      );

      if (retryCount < 2) {
        console.log(`--------------- RETRY START  ${file?.name} | Attempt ${retryCount + 2} | failedFiles ARRAY  : ${failedFiles}`);
        return processFile(file, retryCount + 1);
      } else {
        console.log(`Max retries reached for ${file?.name}`);
        failedFiles.push({
          fileName: file?.name,
          error: err.message
        });
        failCount++;
        return { fileName: file?.name, error: err.message };
      }
    }
  }

  const MAX_CONCURRENT = 1;
  let activeCount = 0;
  let pageToken = null;
  let finished = false;
  let batchNumber = 0;

  async function getNextBatch() {
    if (finished) return [];

    batchNumber++;

    console.log(`\n==============================`);
    console.log(`📦 FETCHING BATCH ${batchNumber}`);
    console.log(`==============================`);
    let listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')&key=${apiKey}&fields=nextPageToken,files(id,name,mimeType)&pageSize=100`;

    if (pageToken) listUrl += `&pageToken=${pageToken}`;

    const res = await axios.get(listUrl);
    const files = res.data.files || [];

    console.log(`📦 Batch ${batchNumber} fetched files:`, files.length);

    console.log("📦 Drive batch fetched:", res.data.files?.length);
    console.log("EXT PAGE TOKEN :", res.data.nextPageToken);

    pageToken = res.data.nextPageToken;
    if (!pageToken) finished = true;

    return files.map(file => ({
      ...file,
      batch: batchNumber
    }));
  }

  async function startProcessing() {
    let queue = await getNextBatch();
    const results = [];
    console.log("START PROCESSING OF ACTUAL IMAGE S3 UPLOAD DOWNLOAD ETC------>>>>>>>>>")
    while (queue.length > 0 || !finished || activeCount > 0) {

      while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
        const file = queue.shift();
        console.log(
          `🚀 START PROCESSING: ${file.name} | Batch: ${file.batch}`
        ); activeCount++;

        processFile(file)
          .then(result => results.push(result))
          .catch(err => results.push({ error: err.message }))
          .finally(() => {

            activeCount--;
            console.log(
              `✅ DONE: ${file.name} | Batch: ${file.batch} | Active: ${activeCount}`
            );

          });
      }

      if (queue.length === 0 && !finished) {
        console.log("QUEUE EMPTY, FETCHING NEXT BATCH FORM DRIVE ---------------...........");
        queue = await getNextBatch();
      }
      // if (queue.length < MAX_CONCURRENT && !finished) {
      //   console.log("Prefetching more files.................");
      //   const newBatch = await getNextBatch();
      //   queue.push(...newBatch);
      // }
      await new Promise(resolve => setImmediate(resolve));
    }

    if (finished && activeCount === 0) {
      console.log(`\n🎉 ALL BATCHES COMPLETED`);
      console.log(`Total Batches: ${batchNumber}`);
    }

    return results;
  }

  const results = await startProcessing();

  const finalSuccessCount = await WebLink.countDocuments({
    orderId: orderId.toString(),
    mainFolderId,
    status: "done"
  });

  console.log("===== FINAL REPORT =====");
  console.log("Total from Drive:", totalDriveFiles);
  console.log("Successfully Uploaded:", finalSuccessCount);
  console.log("Failed:", failCount);
  console.log("========================");
  // const uploadedFiles = await Promise.all(uploadPromises);
  console.log("uploadedFiles -----------", results);
  console.log("Upload completed for orderId:", orderId);


    if (finalSuccessCount >= totalDriveFiles - 5) {
      try {
      console.log(
        "All files uploaded successfully. Starting face count..."
      );

      const formData = new FormData();
      formData.append("folder_name", folderName);
      formData.append("folderId", mainFolderId);
      formData.append("userId", customerId);

      const faceResponse = await axios.post(
        "https://horaservices.com/face-api/count-unique-persons",
        formData,
        {
          headers: formData.getHeaders
            ? formData.getHeaders()
            : {
              "Content-Type": "multipart/form-data",
            },
        }
      );
    } catch (error) {
      console.error(
        "❌ Face Count API Error:",
        error?.response?.data || error.message
      );
    }
  }

  const updatedOrder = await OrderModel.findOneAndUpdate(
    { order_id: orderId },
    {
      $set: {
        "imageUploadCounts.totalWeblink": finalSuccessCount,
        "imageUploadCounts.AllImagesUploadedAt": new Date()
      }
    }
  );
  const updatedOrderId = updatedOrder?.order_id + 10800
  if (updatedOrder?.phone_no) {
    await sendWhatsApp(updatedOrder.phone_no, updatedOrderId, updatedOrder.orderWebLink);
  }

  return results;
  // await new Promise(resolve => setImmediate(resolve));

}


async function uploadSingleImage({
  file,
  folderName,
  customerId,
  vendorId,
  phoneNo,
}) {
  const folderPath = vendorId
    ? `${folderName}_${customerId}_${vendorId}`
    : `${folderName}_${customerId}`;

  const filePath = file.path;
  const fileName = file.filename;

  const thumbnailPath = `${filePath.replace(
    /\.(png|jpeg|jpg)$/i,
    ""
  )}_thumbnail.webp`;

  await generateThumbnail(filePath, thumbnailPath);

  const s3Response = await uploadFileToS3(
    filePath,
    fileName,
    folderPath,
    phoneNo
  );

  const thumbFileName = `thumb_${fileName.replace(
    /\.(png|jpeg|jpg)$/i,
    ""
  )}.webp`;

  const s3ThumbResponse = await uploadFileToS3(
    thumbnailPath,
    thumbFileName,
    folderPath,
    phoneNo
  );

  fs.unlinkSync(filePath);
  fs.unlinkSync(thumbnailPath);

  return {
    fileUrl: s3Response.Location,
    s3Key: s3Response.Key,
    thumbnailUrl: s3ThumbResponse.Location,
    thumbnailKey: s3ThumbResponse.Key,
  };
}


module.exports = { handleDriveFolderUpload, uploadSingleImage };
// http://localhost:3001/weblink-gallery?folderName=23360_695755bea533d6d56bc521e7_9406754372&customerId=695755bea533d6d56bc521e7
