const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WebLink = require("../models/weblink-images.js");
const OrderModel = require("../models/order.js")
const { sendWhatsApp } = require('../utils/whatsappservice.js');
const FolderModel = require("../models/folder.js");
const FormData = require("form-data");
const AWS = require("aws-sdk");
const { emitToSupplier } = require("../../socket.js"); 
const {
  generateThumbnail,
  resizeImage,
  uploadFileToS3,
  generateVideoPreview,
  compressVideo,
  uploadVideoParts,
  deleteFileWithRetry,
  getVideoDuration,
  compressVideoInChunks,
  create2880Image,
  rotateImageInPlace,
} = require("../utils/auth.util.js");
const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
const sheetApikey = process.env.GOOGLE_SCRIPT_DEPLOYMENT_ID;

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const BUCKET_NAME = "photography-hora";


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

async function detectImageOrientation(filePath) {
  try {
    console.log(
      "🤖 ORIENTATION API START:",
      filePath
    );

    const formData = new FormData();

    formData.append(
      "file",
      fs.createReadStream(filePath)
    );

    const response = await axios.post(
      "https://horaservices.com/face-api/detect-orientation",
      formData,
      {
        headers: formData.getHeaders(),

        maxContentLength: Infinity,
        maxBodyLength: Infinity,

        timeout: 120000
      }
    );

    console.log(
      "🤖 ORIENTATION API RESPONSE:",
      response.data
    );

    return response.data;

  } catch (error) {

    console.error(
      "❌ ORIENTATION API ERROR:",
      error?.response?.data ||
      error.message
    );
    return {
      success: false,
      rotation: 0,
      confidence: 0,
      autoRotated: false,
      reason: "orientation_api_failed"
    };
  }
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

  let uploadedImageCount = 0;
  let faceApiBatchCount = 0;

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
        let path2880;
        try {
          // File Paths for all variations
          thumbnailPath = path.join(tempDir, `thumb_${driveFileId}.webp`);
          path2880 = path.join(tempDir, `2880_${driveFileId}.jpg`);
          
          const fileName2880 = `2880_${driveFileId}.jpeg`;
          const thumbFileName = `thumb_${driveFileId}.webp`;

          // STEP 3: Create 2880 image once
          await create2880Image(filePath, path2880);

          // STEP 4: Orientation API on same 2880 image
          const orientationResult =
            await detectImageOrientation(path2880);

          const rotation =
            Number(orientationResult?.rotation || 0);

          console.log("PYTHON ROTATION:", rotation);
          console.log("PYTHON CONFIDENCE:", orientationResult?.confidence);
          console.log("PYTHON FACES:", orientationResult?.faces);
          console.log("PYTHON REASON:", orientationResult?.reason);

          // STEP 5: Rotate same 2880 file
          await rotateImageInPlace(path2880, rotation);

          // STEP 6: Generate thumbnail from final 2880
          await generateThumbnail(
            path2880,
            thumbnailPath,
            0
          );

          console.log(
            "STEP 5 VARIATIONS GENERATED SUCCESSFULLY:",
            file.name
          );



          const uploadThumb = uploadFileToS3(
            thumbnailPath,
            thumbFileName,
            folderPath,
            phoneNo,
            "image/webp"
          );

          const upload2880 = uploadFileToS3(
            path2880,
            fileName2880,
            folderPath,
            phoneNo,
            "image/jpeg"
          );


          // Wait for all 4 uploads to finish
          const [thumb, res2880] = await Promise.all([
            uploadThumb,
            upload2880,
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

                  originalUrl: res2880?.Location || null,
                  originalKey: res2880?.Key,

                  thumbnailImageUrl: thumb?.Location || null,
                  thumbnailKey: thumb?.Key || null,

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
          uploadedImageCount++;


          if (uploadedImageCount % 20 === 0) {
            faceApiBatchCount++;

            try {
              console.log(`Calling Face API for batch ${faceApiBatchCount}`);

              const formData = new FormData();
              formData.append("folder_name", folderName);
              formData.append("folderId", mainFolderId);
              formData.append("userId", customerId);
              formData.append("isLastBatch", "false");

              await axios.post(
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
            } catch (err) {
              console.error("Face API batch error", err.message);
            }
          }

          if (filePath && fs.existsSync(filePath)) {
            await deleteFileWithRetry(filePath);
          }
          if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            await deleteFileWithRetry(thumbnailPath);
          }
          if (path2880 && fs.existsSync(path2880)) {
            await deleteFileWithRetry(path2880);
          }

          return { type: "image", fileName: originalName };
        }
        catch (error) {
          // Cleanup on Failure
          if (filePath && fs.existsSync(filePath)) await deleteFileWithRetry(filePath).catch(() => { });
          if (thumbnailPath && fs.existsSync(thumbnailPath)) await deleteFileWithRetry(thumbnailPath).catch(() => { });
          if (path2880 && fs.existsSync(path2880)) await deleteFileWithRetry(path2880).catch(() => { });

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
      else {
        console.log(`⚠️ Unsupported format: ${file.name}`);

        // ==========================================
        // DELETE ORIGINAL FILE FROM tempUploads
        // ==========================================
        if (filePath) {
          try {
            if (fs.existsSync(filePath)) {
              console.log("🗑️ DELETE ORIGINAL TEMP FILE:", filePath);

              await deleteFileWithRetry(filePath);

              // Double check
              if (!fs.existsSync(filePath)) {
                console.log("✅ ORIGINAL TEMP FILE DELETED:", filePath);
              } else {
                console.log("❌ ORIGINAL TEMP FILE STILL EXISTS:", filePath);
              }
            } else {
              console.log("⚠️ ORIGINAL TEMP FILE NOT FOUND:", filePath);
            }
          } catch (deleteError) {
            console.error(
              "❌ ORIGINAL TEMP FILE DELETE ERROR:",
              deleteError.message
            );
          }
        }

        // ==========================================
        // DELETE MONGO DOCUMENT
        // ==========================================
        try {
          const deleteResult = await WebLink.deleteOne({
            driveFileId: file.id,
            orderId: orderId.toString(),
            mainFolderId
          });

          console.log(
            "🗑️ MONGO DELETE RESULT:",
            deleteResult
          );

        } catch (dbError) {
          console.error(
            "❌ MONGO DELETE ERROR:",
            dbError.message
          );
        }

        return {
          skipped: true,
          reason: "unsupported_format",
          fileName: file.name
        };
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

      if (filePath && fs.existsSync(filePath)) await deleteFileWithRetry(filePath).catch(() => { });
      if (thumbnailPath && fs.existsSync(thumbnailPath)) await deleteFileWithRetry(thumbnailPath).catch(() => { });
      if (clipPath && fs.existsSync(clipPath)) await deleteFileWithRetry(clipPath).catch(() => { });

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
        return await processFile(file, retryCount + 1);
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
      formData.append("isLastBatch", "true");

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

  await FolderModel.updateOne(
    { _id: mainFolderId },
    { $set: { status: "done" } }
  );

  console.log(`Folder status set to "done" for mainFolderId: ${mainFolderId}`);

  const updatedOrderId = updatedOrder?.order_id + 10800

  const whatsappLink = `https://horaservices.com`;

  if (updatedOrder?.phone_no) {
    await sendWhatsApp(updatedOrder.phone_no, updatedOrderId, whatsappLink);
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


// Helper: Fetch all original files from S3 folder
async function getS3FolderFiles(folderPrefix) {
  let isTruncated = true;
  let continuationToken = null;
  let allFiles = [];

  // Ensure prefix ends with '/'
  const prefix = folderPrefix.endsWith("/") ? folderPrefix : `${folderPrefix}/`;

  while (isTruncated) {
    const params = {
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken
    };

    const response = await s3.listObjectsV2(params).promise();

    // Filter out already processed thumb_ / 2880_ files and sub-folders
    const originalFiles = (response.Contents || []).filter((item) => {
      const filename = path.basename(item.Key);
      return (
        !item.Key.endsWith("/") &&
        !filename.startsWith("thumb_") &&
        !filename.startsWith("2880_") &&
        !filename.startsWith("clip_")
      );
    });

    allFiles.push(...originalFiles);

    isTruncated = response.IsTruncated;
    continuationToken = response.NextContinuationToken;
  }

  return allFiles;
}

const { pipeline } = require("stream/promises");

const SUPPLIER_IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".gif",
]);
const SUPPLIER_VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
]);

const SUPPLIER_MAX_RETRIES = 2;

const activeSupplierFolders = new Set();

function getMediaTypeFromKey(key) {
  const ext = path.extname(key).toLowerCase();
  if (SUPPLIER_IMAGE_EXTS.has(ext)) return "image";
  if (SUPPLIER_VIDEO_EXTS.has(ext)) return "video";
  return null;
}

function buildS3Url(key) {
  const region = (s3.config && s3.config.region) || "eu-north-1";
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${encodedKey}`;
}

async function downloadS3ObjectToFile(key, dest) {
  const readStream = s3
    .getObject({ Bucket: BUCKET_NAME, Key: key })
    .createReadStream();
  const writeStream = fs.createWriteStream(dest);
  await pipeline(readStream, writeStream);
}

async function deleteS3Object(key) {
  await s3.deleteObject({ Bucket: BUCKET_NAME, Key: key }).promise();
}

async function safeDeleteLocalFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      await deleteFileWithRetry(filePath);
    }
  } catch (err) {
    console.error("⚠️ TEMP FILE DELETE ERROR:", filePath, err.message);
  }
}


const SUPPLIER_CONCURRENCY = 1; 
const SUPPLIER_VIDEO_CRF = 22;
const VIDEO_PART_SIZE = 25 * 1024 * 1024; 
const VIDEO_QUEUE_SIZE = 3;              
const PROCESSED_PREFIXES = ["thumb_", "2880_", "1080_", "clip_"];

async function processSupplierS3Folder({ folderId, folderName, userId, subFolderId }) {
  const lockKey = `${folderId}:${subFolderId ? String(subFolderId) : "all"}`;

  if (activeSupplierFolders.has(lockKey)) {
    return { success: false, alreadyRunning: true };
  }
  activeSupplierFolders.add(lockKey);

  const tempDir = path.join(__dirname, "tempUploads");


  async function saveAndEmit(fileId, setFields) {
    const doc = await WebLink.findOneAndUpdate(
      { fileId, mainFolderId: folderId },
      {
        $set: {
          fileId,
          mainFolderId: folderId,
          orderById: userId,
          status: "done",
          ...setFields,
        },
        ...(subFolderId ? { $addToSet: { folderIds: subFolderId } } : {}),
      },
      { upsert: true, new: true }
    ).lean();

    emitToSupplier({ userId, folderId }, "media:done", {
      folderId: String(folderId),
      subFolderId: subFolderId || null,
      file: doc,
    });

    return doc;
  }

  try {
    console.log(`🚀 SUPPLIER PROCESSING START | folder: ${folderName}`);

    await FolderModel.updateOne({ _id: folderId }, { $set: { status: "processing" } });

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const s3Objects = await getS3FolderFiles(folderName);

    const mediaFiles = [];
    let skippedCount = 0;

    for (const obj of s3Objects) {
      const type = getMediaTypeFromKey(obj.Key);

      if (type !== "image" && type !== "video") {
        skippedCount++;
        continue;
      }

      const fileId = path.basename(obj.Key);

      if (PROCESSED_PREFIXES.some((p) => fileId.startsWith(p))) continue;

      if (subFolderId) {
        const fileSubFolderId = path.parse(fileId).name.split("_")[0];
        if (String(fileSubFolderId) !== String(subFolderId)) continue;
      }

      mediaFiles.push({
        key: obj.Key,
        fileId,
        baseId: path.parse(fileId).name,
        type,
      });
    }

    const doneDocs = await WebLink.find({ mainFolderId: folderId, status: "done" })
      .select("fileId")
      .lean();
    const doneIds = new Set(doneDocs.map((d) => d.fileId));

    console.log(`📦 Pending: ${mediaFiles.length} | Skipped: ${skippedCount}`);

    emitToSupplier({ userId, folderId }, "media:processing:start", {
      folderId: String(folderId),
      total: mediaFiles.length,
    });

    async function processImage({ key: originalKey, fileId, baseId }) {
      if (doneIds.has(fileId)) {
        await deleteS3Object(originalKey);
        return "cleaned";
      }

      const localOriginal = path.join(tempDir, fileId);
      const local2880 = path.join(tempDir, `2880_${baseId}.jpg`);
      const fileName2880 = `2880_${baseId}.jpeg`;

      try {
        await downloadS3ObjectToFile(originalKey, localOriginal);

        // STEP 1: Create 2880 image once
        await create2880Image(localOriginal, local2880);

        // STEP 2: Detect orientation using 2880 image
        const orientation = await detectImageOrientation(local2880);
        const rotation = Number(orientation?.rotation || 0);

        // STEP 3: Rotate the same 2880 file
        await rotateImageInPlace(local2880, rotation);

        const res2880 = await uploadFileToS3(local2880, fileName2880, folderName, userId, "image/jpeg");
        if (!res2880?.Key) throw new Error("S3 upload did not return Key for 2880 image");

        await saveAndEmit(fileId, {
          type: "image",
          originalUrl: res2880.Location || null,
          originalKey: res2880.Key,
        });

        if (originalKey !== res2880.Key) {
          try {
            await deleteS3Object(originalKey);
          } catch (delErr) {
            console.error(`⚠️ Original delete failed: ${originalKey}`, delErr.message);
          }
        }

        return "done";
      } finally {
        await safeDeleteLocalFile(localOriginal);
        await safeDeleteLocalFile(local2880);
      }
    }

    async function processVideo({ key: originalKey, fileId, baseId }) {
      if (doneIds.has(fileId)) {
        await deleteS3Object(originalKey);
        return "cleaned";
      }

      const clipFileName = `clip_${baseId}.mp4`;
      const compressedFileName = `1080_${baseId}.mp4`;

      const localOriginal = path.join(tempDir, fileId);
      const localClip = path.join(tempDir, clipFileName);
      const localCompressed = path.join(tempDir, compressedFileName);

      try {
        await downloadS3ObjectToFile(originalKey, localOriginal);

        const duration = await getVideoDuration(localOriginal);

        await generateVideoPreview(localOriginal, localClip, 3, 0);

        await compressVideo(localOriginal, localCompressed, SUPPLIER_VIDEO_CRF, "libx265");

        const uploadOpts = { partSize: VIDEO_PART_SIZE, queueSize: VIDEO_QUEUE_SIZE };

        const resClip = await uploadVideoParts(
          localClip, clipFileName, folderName, "video/mp4", uploadOpts
        );
        const resVideo = await uploadVideoParts(
          localCompressed, compressedFileName, folderName, "video/mp4", uploadOpts
        );

        if (!resClip?.Key || !resVideo?.Key) {
          throw new Error("S3 upload did not return Key for video/clip");
        }

        await saveAndEmit(fileId, {
          type: "video",
          originalUrl: resVideo.Location || null,
          originalKey: resVideo.Key,
          videoClipUrl: resClip.Location || null,
          videoClipKey: resClip.Key,
          duration: duration || "",
        });

        if (originalKey !== resVideo.Key) {
          try {
            await deleteS3Object(originalKey);
          } catch (delErr) {
            console.error(`⚠️ Original delete failed: ${originalKey}`, delErr.message);
          }
        }

        return "done";
      } finally {
        await safeDeleteLocalFile(localOriginal);
        await safeDeleteLocalFile(localClip);
        await safeDeleteLocalFile(localCompressed);
      }
    }

    const stats = { done: 0, cleaned: 0, failed: 0 };
    const failedFiles = [];

    async function processWithRetry(file) {
      for (let attempt = 0; attempt <= SUPPLIER_MAX_RETRIES; attempt++) {
        try {
          const status =
            file.type === "video" ? await processVideo(file) : await processImage(file);
          stats[status]++;
          return;
        } catch (err) {
          console.error(`❌ ${file.fileId} attempt ${attempt + 1} failed:`, err.message);
          if (attempt === SUPPLIER_MAX_RETRIES) {
            stats.failed++;
            failedFiles.push({ fileName: file.fileId, error: err.message });
            emitToSupplier({ userId, folderId }, "media:failed", {
              folderId: String(folderId),
              fileId: file.fileId,
              error: err.message,
            });
          }
        }
      }
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < mediaFiles.length) {
        const file = mediaFiles[cursor++];
        await processWithRetry(file);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SUPPLIER_CONCURRENCY, mediaFiles.length) }, worker)
    );

    await FolderModel.updateOne(
      { _id: folderId },
      { $set: { status: stats.failed === 0 ? "done" : "failed" } }
    );

    emitToSupplier({ userId, folderId }, "media:folder:done", {
      folderId: String(folderId),
      ...stats,
      failedFiles,
    });

    console.log("===== SUPPLIER FINAL REPORT =====", stats, failedFiles);
    return { success: true, ...stats, failedFiles };
  } catch (error) {
    console.error("❌ Error in processSupplierS3Folder:", error);
    try {
      await FolderModel.updateOne({ _id: folderId }, { $set: { status: "failed" } });
    } catch (e) {
      console.error("❌ Could not mark folder as failed:", e.message);
    }
    throw error;
  } finally {
    activeSupplierFolders.delete(lockKey);
  }
}





function getMediaTypeFromKey(key) {
  const ext = path.extname(key).toLowerCase();

  if (SUPPLIER_IMAGE_EXTS.has(ext)) return "image";
  if (SUPPLIER_VIDEO_EXTS.has(ext)) return "video";

  return null;
}

function buildS3Url(key) {
  const region = (s3.config && s3.config.region) || "eu-north-1";
  const encodedKey = key
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${encodedKey}`;
}

async function downloadS3ObjectToFile(key, dest) {
  const readStream = s3
    .getObject({
      Bucket: BUCKET_NAME,
      Key: key,
    })
    .createReadStream();

  const writeStream = fs.createWriteStream(dest);

  await pipeline(readStream, writeStream);
}

async function deleteS3Object(key) {
  await s3
    .deleteObject({
      Bucket: BUCKET_NAME,
      Key: key,
    })
    .promise();
}

async function safeDeleteLocalFile(filePath) {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      await deleteFileWithRetry(filePath);
    }
  } catch (err) {
    console.error(
      "TEMP FILE DELETE ERROR:",
      filePath,
      err.message
    );
  }
}


async function getOrderS3FolderFiles(folderPrefix) {
  let isTruncated = true;
  let continuationToken = null;
  const allFiles = [];

  const prefix = folderPrefix.endsWith("/")
    ? folderPrefix
    : `${folderPrefix}/`;

  while (isTruncated) {
    const params = {
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    };

    const response = await s3.listObjectsV2(params).promise();

    const originalFiles = (response.Contents || []).filter((item) => {
      const filename = path.basename(item.Key);

      return (
        !item.Key.endsWith("/") &&
        !filename.startsWith("thumb_") &&
        !filename.startsWith("2880_") &&
        !filename.startsWith("1080_") &&
        !filename.startsWith("clip_")
      );
    });

    allFiles.push(...originalFiles);

    isTruncated = response.IsTruncated;
    continuationToken = response.NextContinuationToken;
  }

  return allFiles;
}

const FACE_BATCH_SIZE = 20;
const HEAD_OBJECT_CONCURRENCY = 10;

function formatPhoneForSheet(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return `+${digits}`;
}

function formatDateForSheet(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

const toInclusionKey = (name) => {
  const value = String(name || "").trim();

  if (value === "EditedVideo") {
    return "editedVideos";
  }

  return value.charAt(0).toLowerCase() + value.slice(1);
};

async function processSupplierOrderS3Folder({
  folderId,
  folderName,
  userId,
  inclusionType,
  orderId,
}) {
  const lockKey = `${folderId}_${inclusionType}`;

  if (activeSupplierFolders.has(lockKey)) {
    return {
      success: true,
      message: "This inclusion is already processing",
      data: { folderId },
    };
  }

  activeSupplierFolders.add(lockKey);

  const tempDir = path.join(__dirname, "tempUploads");
  const ctx = { userId, folderId };



  async function saveAndEmit(fileId, fileInclusionType, setFields) {
    const order = await OrderModel.findOne({ order_id: orderId })
      .select("_id fromId phone_no")
      .lean();

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const doc = await WebLink.findOneAndUpdate(
      { fileId, mainFolderId: folderId },
      {
        $set: {
          fileId,
          mainFolderId: folderId,
          orderId: String(order._id),
          orderById: String(order.fromId),
          orderByName: order.phone_no || "",
          status: "done",
          inclusionType: fileInclusionType,
          ...setFields,
        },
      },
      { upsert: true, new: true }
    ).lean();

    emitToSupplier(ctx, "media:done", {
      folderId: String(folderId),
      file: doc,
    });

    return doc;
  }


  async function callFaceCountApi(isLastBatch, batchNumber = null) {
    try {
      console.log(
        `🤖 FACE API START | Batch: ${batchNumber || "FINAL"} | isLastBatch: ${isLastBatch}`
      );

      const formData = new FormData();
      formData.append("folder_name", folderName);
      formData.append("folderId", String(folderId));
      formData.append("userId", String(userId));
      formData.append("isLastBatch", String(isLastBatch));

      const response = await axios.post(
        "https://horaservices.com/face-api/count-unique-persons",
        formData,
        { headers: formData.getHeaders(), timeout: 120000 }
      );

      console.log("🤖 FACE API RESPONSE:", response.data);
      return response.data;
    } catch (error) {
      console.error(
        "❌ FACE API ERROR:",
        error?.response?.data || error.message
      );
      return null; // kabhi throw nahi karega, upload flow nahi rukega
    }
  }

  async function safeDeleteS3(key) {
    try {
      await deleteS3Object(key);
    } catch (e) {
      console.error("S3 delete failed:", key, e.message);
    }
  }
  async function notifyOrderComplete() {
    let order = null;


    const folderInclusion = await FolderModel.findById(folderId)
      .select("appUploadInclusions")
      .lean();

    console.log(
      "📦 FOLDER INCLUSIONS:",
      JSON.stringify(folderInclusion?.appUploadInclusions, null, 2)
    );

    const contentTypesPayload = (
      folderInclusion?.appUploadInclusions || []
    )
      .filter((item) => item.value === true)
      .map((item) => ({
        linkType: item.inclusionType,
        link: "N/A",
        submittedAt: item.startedAt
          ? new Date(item.startedAt).toLocaleString("en-GB", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          })
          : "N/A",
      }));

    console.log("📊 FINAL CONTENT TYPES:", contentTypesPayload);
    

    try {
      order = await OrderModel.findOne({ order_id: orderId }).lean();

      if (!order) {
        console.log(
          `Notify skipped: ORDER NOT FOUND | order_id: ${orderId} (type: ${typeof orderId})`
        );
        return;
      }

      const orderFolder = await FolderModel.findOne({ orderId })
        .select("shortCode")
        .lean();

      const webLink = orderFolder?.shortCode
        ? `https://horaservices.com/eventcapsule/share/${orderFolder.shortCode}`
        : order.orderWebLink;

      const displayOrderId = Number(order.order_id) + 10800;

      const sheetPayload = {
        targetSheet: "photography_drivelink",
        rawOrderId: String(Number(order.order_id)),
        orderId: String(Number(order.order_id) + 10800),
        orderFulfilmentDate: order?.order_date
          ? new Date(order.order_date).toLocaleDateString("en-GB")
          : "N/A",
        customerNumber: `="${formatPhoneForSheet(order.phone_no)}"`,
        service: "Photography",
        driveLink: "N/A",
        webLink,
        contentTypes: contentTypesPayload,
      };

      console.log("📊 SHEET PAYLOAD:", sheetPayload);

      const sheetUrl = `https://script.google.com/macros/s/${sheetApikey}/exec`;

      const response = await axios.post(sheetUrl, sheetPayload, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      });

      console.log("📊 SHEET RESPONSE:", response.data);

      if (response.data?.status !== "success") {
        throw new Error(
          "Google Sheet API failed: " + JSON.stringify(response.data)
        );
      }

      // Sheet success ke baad flag + startedAt/updatedAt set karo
      const now = new Date();

      await OrderModel.updateOne(
        { order_id: orderId },
        {
          $set: {
            imageUploadByApp: true,
            "imageUploadTracking.updatedAt": now,
          },
        }
      );

      // startedAt sirf tab set ho jab pehle se na ho (null ya missing)
      await OrderModel.updateOne(
        { order_id: orderId, "imageUploadTracking.startedAt": null },
        { $set: { "imageUploadTracking.startedAt": now } }
      );
    } catch (sheetError) {
      console.error("❌ Sheet step failed:", sheetError.message);
      return; // sheet nahi gayi to WhatsApp bhi nahi bhejna
    }

    // WhatsApp alag try me
    try {
      if (order.phone_no) {
        const displayOrderId = Number(order.order_id) + 10800;
        await sendWhatsApp(
          order.phone_no,
          displayOrderId,
          "https://horaservices.com"
        );
        console.log("✅ WhatsApp sent:", displayOrderId);
      }
    } catch (waError) {
      console.error("❌ WhatsApp failed:", waError.message);
    }
  }

  // ---------------- MAIN ----------------

  try {
    console.log(`SUPPLIER PROCESSING START | folder: ${folderName}`);

    await FolderModel.updateOne(
      { _id: folderId },
      { $set: { status: "processing" } }
    );

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // ---------- Collect pending files ----------

    const s3Objects = await getOrderS3FolderFiles(folderName);

    let skippedCount = 0;
    const candidates = [];

    for (const obj of s3Objects) {
      const type = getMediaTypeFromKey(obj.Key);

      if (type !== "image" && type !== "video") {
        skippedCount++;
        continue;
      }

      const fileId = path.basename(obj.Key);

      if (PROCESSED_PREFIXES.some((p) => fileId.startsWith(p))) continue;

      candidates.push({ key: obj.Key, fileId, type });
    }

    // headObject ab parallel (pehle ek-ek karke sequential tha)
    const heads = await mapLimit(
      candidates,
      HEAD_OBJECT_CONCURRENCY,
      async (c) => {
        const head = await s3
          .headObject({ Bucket: BUCKET_NAME, Key: c.key })
          .promise();
        // Old files without metadata -> Color Corrected Photos
        return toInclusionKey(
          head.Metadata?.inclusiontype || "ColorCorrectedPhotos"
        );
      }
    );

    const mediaFiles = [];
    candidates.forEach((c, i) => {
      if (heads[i] !== inclusionType) return; // sirf requested tab ki files
      mediaFiles.push({
        key: c.key,
        fileId: c.fileId,
        baseId: path.parse(c.fileId).name,
        type: c.type,
        inclusionType: heads[i],
      });
    });

    const doneDocs = await WebLink.find({
      mainFolderId: folderId,
      status: "done",
      inclusionType,
    })
      .select("fileId type thumbnailKey")
      .lean();

    const doneMap = new Map(doneDocs.map((d) => [d.fileId, d]));

    console.log(`Pending: ${mediaFiles.length} | Skipped: ${skippedCount}`);

    emitToSupplier(ctx, "media:processing:start", {
      folderId: String(folderId),
      total: mediaFiles.length,
    });

    // ---------- IMAGE ----------

    async function processImage({ key: originalS3Key, fileId, baseId, inclusionType }) {
      const existingDoc = doneMap.get(fileId);

      if (existingDoc?.type === "image" && existingDoc?.thumbnailKey) {
        await deleteS3Object(originalS3Key);
        return "cleaned";
      }

      const localOriginal = path.join(tempDir, fileId);
      const local2880 = path.join(tempDir, `2880_${baseId}.jpg`);
      const localThumbnail = path.join(tempDir, `thumb_${baseId}.webp`);

      const resizedFileName = `2880_${baseId}.jpeg`;
      const thumbnailFileName = `thumb_${baseId}.webp`;

      try {
        await downloadS3ObjectToFile(originalS3Key, localOriginal);

        // STEP 1: Original se 2880 image ek baar create karo
        await create2880Image(localOriginal, local2880);

        // STEP 2: Orientation API ko 2880 image do
        const orientation = await detectImageOrientation(local2880);
        const rotation = Number(orientation?.rotation || 0);

        // STEP 3: Same 2880 file ko in-place rotate karo
        await rotateImageInPlace(local2880, rotation);

        // STEP 4: Final rotated 2880 se thumbnail banao
        await generateThumbnail(local2880, localThumbnail, 0);

        // Dono uploads parallel
        const [resizedResponse, thumbnailResponse] = await Promise.all([
          uploadFileToS3(local2880, resizedFileName, folderName, userId, "image/jpeg"),
          uploadFileToS3(localThumbnail, thumbnailFileName, folderName, userId, "image/webp"),
        ]);

        if (!resizedResponse?.Key) throw new Error("S3 upload failed for resized image");
        if (!thumbnailResponse?.Key) throw new Error("S3 upload failed for thumbnail");

        await saveAndEmit(fileId, inclusionType, {
          type: "image",
          originalUrl: resizedResponse.Location || buildS3Url(resizedResponse.Key),
          originalKey: resizedResponse.Key,
          thumbnailImageUrl:
            thumbnailResponse.Location || buildS3Url(thumbnailResponse.Key),
          thumbnailKey: thumbnailResponse.Key,
        });

        if (
          originalS3Key !== resizedResponse.Key &&
          originalS3Key !== thumbnailResponse.Key
        ) {
          await safeDeleteS3(originalS3Key);
        }

        return "done";
      } finally {
        await Promise.all([
          safeDeleteLocalFile(localOriginal),
          safeDeleteLocalFile(local2880),
          safeDeleteLocalFile(localThumbnail),
        ]);
      }
    }

    // ---------- VIDEO ----------

    async function processVideo({ key: originalS3Key, fileId, baseId, inclusionType }) {
      const existingDoc = doneMap.get(fileId);

      if (existingDoc?.type === "video") {
        await deleteS3Object(originalS3Key);
        return "cleaned";
      }

      const clipFileName = `clip_${baseId}.mp4`;
      const compressedFileName = `1080_${baseId}.mp4`;

      const localOriginal = path.join(tempDir, fileId);
      const localClip = path.join(tempDir, clipFileName);
      const localCompressed = path.join(tempDir, compressedFileName);

      try {
        await downloadS3ObjectToFile(originalS3Key, localOriginal);

        const duration = await getVideoDuration(localOriginal);

        await generateVideoPreview(localOriginal, localClip, 3, 0);
        await compressVideoInChunks(
          localOriginal,
          localCompressed,
          26,
          "libx264",
          300,
          1,
          "veryfast"
        );

        const uploadOpts = {
          partSize: VIDEO_PART_SIZE,
          queueSize: VIDEO_QUEUE_SIZE,
        };

        const [resClip, resVideo] = await Promise.all([
          uploadVideoParts(localClip, clipFileName, folderName, "video/mp4", uploadOpts),
          uploadVideoParts(localCompressed, compressedFileName, folderName, "video/mp4", uploadOpts),
        ]);

        if (!resClip?.Key || !resVideo?.Key) {
          throw new Error("S3 upload failed for video/clip");
        }

        await saveAndEmit(fileId, inclusionType, {
          type: "video",
          originalUrl: resVideo.Location || buildS3Url(resVideo.Key),
          originalKey: resVideo.Key,
          videoClipUrl: resClip.Location || buildS3Url(resClip.Key),
          videoClipKey: resClip.Key,
          duration: duration || "",
        });

        if (originalS3Key !== resVideo.Key) {
          await safeDeleteS3(originalS3Key);
        }

        return "done";
      } finally {
        await Promise.all([
          safeDeleteLocalFile(localOriginal),
          safeDeleteLocalFile(localClip),
          safeDeleteLocalFile(localCompressed),
        ]);
      }
    }

    // ---------- RETRY + WORKERS ----------

    const stats = { done: 0, cleaned: 0, failed: 0 };
    const failedFiles = [];

    let uploadedImageCount = 0;
    let faceApiBatchCount = 0;
    let faceApiQueue = Promise.resolve(); 

    function onImageUploaded() {
      uploadedImageCount++;

      if (uploadedImageCount % FACE_BATCH_SIZE === 0) {
        const currentBatch = ++faceApiBatchCount;
        console.log(`🤖 Queueing Face API batch ${currentBatch}`);
        faceApiQueue = faceApiQueue.then(() =>
          callFaceCountApi(false, currentBatch)
        );
      }
    }

    async function processWithRetry(file) {
      for (let attempt = 0; attempt <= SUPPLIER_MAX_RETRIES; attempt++) {
        let status;

        try {
          status =
            file.type === "video"
              ? await processVideo(file)
              : await processImage(file);
        } catch (err) {
          console.error(
            `${file.fileId} attempt ${attempt + 1} failed:`,
            err.message
          );

          if (attempt === SUPPLIER_MAX_RETRIES) {
            stats.failed++;
            failedFiles.push({ fileName: file.fileId, error: err.message });

            emitToSupplier(ctx, "media:failed", {
              folderId: String(folderId),
              fileId: file.fileId,
              error: err.message,
            });
          }
          continue; // retry
        }

        stats[status]++;

        if (file.type === "image" && status === "done") {
          onImageUploaded();
        }
        return;
      }
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < mediaFiles.length) {
        const file = mediaFiles[cursor++];
        await processWithRetry(file);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(SUPPLIER_CONCURRENCY, mediaFiles.length) },
        worker
      )
    );


    const imageFiles = mediaFiles.filter((f) => f.type === "image");
    const imageIds = new Set(imageFiles.map((f) => f.fileId));
    const failedImageCount = failedFiles.filter((f) =>
      imageIds.has(f.fileName)
    ).length;

    const allImagesOk = imageFiles.length > 0 && failedImageCount === 0;

    await faceApiQueue; 

    if (allImagesOk) {
      console.log("🤖 ALL IMAGES DONE. FINAL FACE COUNT (isLastBatch=true)");
      await callFaceCountApi(true);
    } else {
      console.log(
        `Final face call skipped | images: ${imageFiles.length} | failed: ${failedImageCount}`
      );
    }

    await FolderModel.updateOne(
      { _id: folderId },
      { $set: { status: stats.failed === 0 ? "done" : "failed" } }
    );

    emitToSupplier(ctx, "media:folder:done", {
      folderId: String(folderId),
      ...stats,
      failedFiles,
    });


    console.log(
      `NOTIFY CHECK | allImagesOk: ${allImagesOk} | images: ${imageFiles.length} | failedImages: ${failedImageCount}`
    );

    if (allImagesOk) {
      await notifyOrderComplete();
    }

    console.log("===== SUPPLIER FINAL REPORT =====", stats, failedFiles);

    return { success: true, ...stats, failedFiles };
  } catch (error) {
    console.error("Error in processSupplierS3Folder:", error);

    try {
      await FolderModel.updateOne(
        { _id: folderId },
        { $set: { status: "failed" } }
      );
    } catch (e) {
      console.error("Could not mark folder as failed:", e.message);
    }

    emitToSupplier(ctx, "media:folder:done", {
      folderId: String(folderId),
      done: 0,
      cleaned: 0,
      failed: 0,
      failedFiles: [],
      error: error.message,
    });

    throw error;
  } finally {
    activeSupplierFolders.delete(lockKey);
  }
}


module.exports = { handleDriveFolderUpload, uploadSingleImage, processSupplierS3Folder, processSupplierOrderS3Folder };
