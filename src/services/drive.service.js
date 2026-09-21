const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WebLink = require("../models/weblink-images.js");
const OrderModel = require("../models/order.js")
const { sendWhatsApp } = require('../utils/whatsappservice.js');
const FolderModel = require("../models/folder.js");
const FormData = require("form-data");
const AWS = require("aws-sdk");
const {
  generateThumbnail,
  resizeImage,
  uploadFileToS3,
  generateVideoPreview,
  deleteFileWithRetry,
  getVideoDuration
} = require("../utils/auth.util.js");
const apiKey = process.env.GOOGLE_DRIVE_API_KEY;


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

          console.log(
            "STEP 3 IMAGE ORIENTATION DETECTION START:",
            file.name
          );

          const orientationResult =
            await detectImageOrientation(filePath);

          const rotation =
            Number(orientationResult?.rotation || 0);

          console.log("==============================================");
          console.log("IMAGE:", file.name);
          console.log(
            "PYTHON ROTATION:",
            rotation
          );
          console.log(
            "PYTHON CONFIDENCE:",
            orientationResult?.confidence
          );
          console.log(
            "PYTHON FACES:",
            orientationResult?.faces
          );
          console.log(
            "PYTHON REASON:",
            orientationResult?.reason
          );
          console.log("==============================================");

          console.log(
            "STEP 4 GENERATING IMAGE VARIATIONS:",
            file.name
          );

          const genThumb = generateThumbnail(
            filePath,
            thumbnailPath,
            rotation
          );

          const gen2880 = resizeImage(
            filePath,
            path2880,
            2880,
            rotation
          );

          await Promise.all([
            genThumb,
            gen2880
          ]);

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

  const folder = await FolderModel.findById(mainFolderId).lean();

  const updatedOrderId = updatedOrder?.order_id + 10800

  const whatsappLink = folder?.shortCode
    ? `https://horaservices.com/eventcapsule/share/${folder.shortCode}`
    : updatedOrder.orderWebLink;

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

// ============================================================================
// SUPPLIER S3 FLOW
// ----------------------------------------------------------------------------
// - getS3FolderFiles(...) ko waisa hi rehne do (tumhara existing helper).
// - Ye poora block us file me daalo jisme handleDriveFolderUpload hai, taaki ye
//   sab helpers mil sakein: axios, fs, path, FormData, s3, BUCKET_NAME,
//   WebLink, OrderModel, FolderModel, detectImageOrientation, generateThumbnail,
//   resizeImage, uploadFileToS3, deleteFileWithRetry, generateVideoPreview,
//   getVideoDuration, sendWhatsApp.
// - Purana processSupplierS3Folder delete kar do (ye uska replacement hai).
// ============================================================================

const { pipeline } = require("stream/promises");

const SUPPLIER_IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".gif",
]);
const SUPPLIER_VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
]);

// Drive jaisa: 1 first attempt + 2 retries = total 3 attempts
const SUPPLIER_MAX_RETRIES = 2;

// Same folder ka processing 2 baar parallel na chale (button double click etc.)
const activeSupplierFolders = new Set();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function processSupplierS3Folder(folderId, s3FolderPath, orderId) {
  const lockKey = String(folderId);

  if (activeSupplierFolders.has(lockKey)) {
    console.log(`⏩ Supplier processing already running for folder: ${lockKey}`);
    return { success: false, alreadyRunning: true };
  }
  activeSupplierFolders.add(lockKey);

  try {
    console.log("==================================================");
    console.log("🚀 START SUPPLIER S3 PROCESSING");
    console.log(`Folder ID: ${folderId} | Order ID: ${orderId}`);
    console.log("==================================================");

    // ------------------------------------------------------------------
    // 1. DB se details (jo params me nahi aayi wo model se)
    // ------------------------------------------------------------------
    const folderDoc = await FolderModel.findById(folderId).lean();
    if (!folderDoc) throw new Error(`Folder with ID ${folderId} not found`);

    const orderDoc = await OrderModel.findOne({ order_id: Number(orderId) }).lean();
    if (!orderDoc) throw new Error(`Order with order_id ${orderId} not found`);

    const customerId = String(folderDoc.customerId); // Folder model
    const phoneNo = orderDoc.phone_no || "";          // Order model
    const orderByName = phoneNo;                      // drive flow me bhi phoneNo hi tha
    const mainFolderId = String(folderId);
    const orderIdStr = String(orderId);

    const folderName = String(s3FolderPath).replace(/\/+$/, "");
    const folderPath = folderName; // drive me folderPath = folderName tha

    if (folderDoc.folderName && folderDoc.folderName !== folderName) {
      console.warn(
        `⚠️ folderName mismatch. DB: ${folderDoc.folderName} | Param: ${folderName}`
      );
    }

    const wasAlreadyDone = folderDoc.status === "done";

    await FolderModel.updateOne(
      { _id: folderId },
      { $set: { status: "processing" } }
    );

    const tempDir = path.join(__dirname, "tempUploads");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // ------------------------------------------------------------------
    // 2. S3 se original files ki list (thumb_/2880_/clip_ already filter hote hain)
    // ------------------------------------------------------------------
    const s3Objects = await getS3FolderFiles(folderName);

    const mediaFiles = [];
    let unsupportedCount = 0;

    for (const obj of s3Objects) {
      const fileId = path.basename(obj.Key);
      const type = getMediaTypeFromKey(obj.Key);

      if (!type) {
        unsupportedCount++;
        console.log(`⚠️ Unsupported format, skipping: ${obj.Key}`);
        continue;
      }

      mediaFiles.push({
        key: obj.Key,
        fileId,                          // WebLink.fileId (uuid.ext)
        baseId: path.parse(fileId).name, // thumb_/2880_/clip_ names ke liye (bina ext)
        type,
      });
    }

    // Pehle ke run me jo images done ho chuki hain unka original S3 se delete ho chuka hota
    // hai, isliye wo list me nahi aayengi. Unhe total me jod dete hain.
    const listedIds = new Set(mediaFiles.map((f) => f.fileId));
    const doneImagesBefore = await WebLink.find({
      orderId: orderIdStr,
      mainFolderId,
      status: "done",
      type: "image",
    })
      .select("fileId")
      .lean();
    const deletedOriginalsCount = doneImagesBefore.filter(
      (d) => !listedIds.has(d.fileId)
    ).length;

    const totalMediaFiles = mediaFiles.length + deletedOriginalsCount;

    console.log(`📦 Raw objects in S3: ${s3Objects.length}`);
    console.log(`📦 Supported media files to look at: ${mediaFiles.length}`);
    console.log(`📦 Already-done images (original deleted): ${deletedOriginalsCount}`);
    console.log(`📦 Unsupported files: ${unsupportedCount}`);
    console.log(`📦 TOTAL MEDIA: ${totalMediaFiles}`);

    await OrderModel.findOneAndUpdate(
      { order_id: orderDoc.order_id },
      { $set: { "imageUploadCounts.totalFromDrive": totalMediaFiles } }
    );

    // ------------------------------------------------------------------
    // 3. Counters (drive flow jaise)
    // ------------------------------------------------------------------
    const failedFiles = [];
    let failCount = 0;
    let uploadedImageCount = 0;
    let faceApiBatchCount = 0;

    // ------------------------------------------------------------------
    // Face API helper (batch + last batch dono ke liye)
    // ------------------------------------------------------------------
    async function callFaceApi(isLastBatch) {
      const formData = new FormData();
      formData.append("folder_name", folderName);
      formData.append("folderId", mainFolderId);
      formData.append("userId", customerId);
      formData.append("isLastBatch", isLastBatch ? "true" : "false");

      return axios.post(
        "https://horaservices.com/face-api/count-unique-persons",
        formData,
        {
          headers: formData.getHeaders
            ? formData.getHeaders()
            : { "Content-Type": "multipart/form-data" },
        }
      );
    }

    // ------------------------------------------------------------------
    // 4a. IMAGE: original download -> orientation -> thumb + 2880 -> S3 upload
    //             -> WebLink done -> S3 se ORIGINAL DELETE
    // ------------------------------------------------------------------
    async function processImage(file) {
      const { key: originalKey, fileId, baseId } = file;

      const localOriginal = path.join(tempDir, fileId);
      const thumbLocal = path.join(tempDir, `thumb_${baseId}.webp`);
      const local2880 = path.join(tempDir, `2880_${baseId}.jpg`);

      const thumbFileName = `thumb_${baseId}.webp`;
      const fileName2880 = `2880_${baseId}.jpeg`;

      try {
        console.log(`⬇️ STEP 1 DOWNLOAD FROM S3: ${fileId}`);
        await downloadS3ObjectToFile(originalKey, localOriginal);
        console.log(`✅ STEP 2 DOWNLOAD COMPLETED: ${fileId}`);

        console.log(`STEP 3 ORIENTATION DETECTION: ${fileId}`);
        const orientationResult = await detectImageOrientation(localOriginal);
        const rotation = Number(orientationResult?.rotation || 0);

        console.log("==============================================");
        console.log("IMAGE:", fileId);
        console.log("PYTHON ROTATION:", rotation);
        console.log("PYTHON CONFIDENCE:", orientationResult?.confidence);
        console.log("PYTHON FACES:", orientationResult?.faces);
        console.log("PYTHON REASON:", orientationResult?.reason);
        console.log("==============================================");

        console.log(`STEP 4 GENERATING VARIATIONS: ${fileId}`);
        await Promise.all([
          generateThumbnail(localOriginal, thumbLocal, rotation),
          resizeImage(localOriginal, local2880, 2880, rotation),
        ]);
        console.log(`STEP 5 VARIATIONS GENERATED: ${fileId}`);

        const [thumb, res2880] = await Promise.all([
          uploadFileToS3(thumbLocal, thumbFileName, folderPath, phoneNo, "image/webp"),
          uploadFileToS3(local2880, fileName2880, folderPath, phoneNo, "image/jpeg"),
        ]);
        console.log(`STEP 6 S3 UPLOADS COMPLETE: ${fileId}`);

        if (!res2880?.Key || !thumb?.Key) {
          throw new Error("S3 upload did not return Key for thumb / 2880");
        }

        console.log(`STEP 7 DB UPDATE START: ${fileId}`);
        await WebLink.updateOne(
          { fileId, orderId: orderIdStr },
          {
            $set: {
              fileId,
              orderId: orderIdStr,

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
            },
          },
          { upsert: false }
        );
        console.log(`STEP 8 DB UPDATE DONE: ${fileId}`);

        // ---- Ab supplier ka ORIGINAL S3 se delete (sirf DB done hone ke baad) ----
        if (originalKey !== res2880.Key && originalKey !== thumb.Key) {
          try {
            await deleteS3Object(originalKey);
            console.log(`🗑️ STEP 9 S3 ORIGINAL DELETED: ${originalKey}`);
          } catch (delErr) {
            // File already done hai, isliye fail nahi karna. Next run me cleanup ho jayega.
            console.error(`⚠️ S3 ORIGINAL DELETE FAILED: ${originalKey}`, delErr.message);
          }
        }

        uploadedImageCount++;

        if (uploadedImageCount % 20 === 0) {
          faceApiBatchCount++;
          try {
            console.log(`Calling Face API for batch ${faceApiBatchCount}`);
            await callFaceApi(false);
          } catch (err) {
            console.error("Face API batch error", err.message);
          }
        }

        return { type: "image", fileName: fileId };
      } finally {
        await safeDeleteLocalFile(localOriginal);
        await safeDeleteLocalFile(thumbLocal);
        await safeDeleteLocalFile(local2880);
      }
    }

    // ------------------------------------------------------------------
    // 4b. VIDEO: original S3 me hi rehta hai (re-upload nahi), sirf clip banti hai
    // ------------------------------------------------------------------
    async function processVideo(file) {
      const { key: originalKey, fileId, baseId } = file;

      const localOriginal = path.join(tempDir, fileId);
      const clipLocal = path.join(tempDir, `clip_${baseId}.mp4`);

      try {
        console.log(`⬇️ STEP 1 DOWNLOAD VIDEO FROM S3: ${fileId}`);
        await downloadS3ObjectToFile(originalKey, localOriginal);
        console.log(`✅ STEP 2 DOWNLOAD COMPLETED: ${fileId}`);

        console.log(`STEP 3 GENERATE PREVIEW CLIP: ${fileId}`);
        await generateVideoPreview(localOriginal, clipLocal, 3);
        const durationVal = await getVideoDuration(localOriginal);
        console.log(`STEP 4 CLIP GENERATED: ${fileId}`);

        console.log(`STEP 5 UPLOAD CLIP TO S3: ${fileId}`);
        const clip = await uploadFileToS3(
          clipLocal,
          path.basename(clipLocal),
          folderPath,
          phoneNo,
          "video/mp4"
        );
        console.log(`STEP 6 CLIP UPLOAD COMPLETE: ${fileId}`);

        if (!clip?.Key) {
          throw new Error("S3 upload did not return Key for clip");
        }

        await WebLink.updateOne(
          { fileId, orderId: orderIdStr },
          {
            $set: {
              fileId,
              orderId: orderIdStr,

              orderById: customerId,
              orderByName,

              type: "video",

              // Original video wahi hai jo supplier ne S3 me upload kiya (delete nahi hota)
              originalUrl: buildS3Url(originalKey),
              originalKey: originalKey,

              thumbnailImageUrl: null,
              thumbnailKey: null,

              videoClipUrl: clip?.Location || null,
              videoClipKey: clip?.Key || null,
              duration: durationVal,

              mainFolderId,
              status: "done",
            },
          },
          { upsert: false }
        );
        console.log(`STEP 7 VIDEO DB UPDATE DONE: ${fileId}`);

        return { type: "video", fileName: fileId };
      } finally {
        await safeDeleteLocalFile(localOriginal);
        await safeDeleteLocalFile(clipLocal);
      }
    }

    // ------------------------------------------------------------------
    // 5. Ek file: skip check + placeholder + retry loop (drive processFile jaisa)
    // ------------------------------------------------------------------
    async function processFile(file, index) {
      const { key: originalKey, fileId, type } = file;
      const logPrefix = `[File ${index + 1}/${mediaFiles.length}] [${fileId}]`;

      console.log("\n--------------------------------------------------");
      console.log(`🚀 ${logPrefix} START (${type})`);

      const existingFile = await WebLink.findOne({ fileId, orderId: orderIdStr });

      // Already uploaded
      if (existingFile?.status === "done") {
        console.log(`⏩ FILE ALREADY DONE: ${fileId}`);

        // Pichhle run me image ka original delete fail hua ho to ab cleanup kar do
        if (type === "image") {
          try {
            await deleteS3Object(originalKey);
            console.log(`🗑️ LEFTOVER ORIGINAL CLEANED: ${originalKey}`);
          } catch (e) {
            console.error(`⚠️ leftover cleanup failed: ${originalKey}`, e.message);
          }
        }
        return { status: "skipped", fileName: fileId };
      }

      // NOTE: "uploading" wali file ko yaha skip nahi karte, kyunki upar lock hai
      // (same folder parallel nahi chalta). Matlab "uploading" pichhle crash ki bachi hui hai.
      if (existingFile?.status === "failed") {
        console.log(`🔄 RETRYING FAILED FILE: ${fileId}`);
      } else if (existingFile?.status === "uploading") {
        console.log(`🔄 STALE UPLOADING FILE, RETRYING: ${fileId}`);
      }

      // Placeholder create / status = uploading
      await WebLink.findOneAndUpdate(
        { fileId, orderId: orderIdStr },
        {
          $set: { status: "uploading" },
          $setOnInsert: { mainFolderId, retryCount: 0 },
        },
        { upsert: true, new: true }
      );

      for (let attempt = 0; attempt <= SUPPLIER_MAX_RETRIES; attempt++) {
        try {
          const result =
            type === "image" ? await processImage(file) : await processVideo(file);

          return { status: "done", ...result };
        } catch (err) {
          console.error(`❌ ${logPrefix} ERROR (attempt ${attempt + 1}):`, err.message);

          await WebLink.updateOne(
            { fileId, orderId: orderIdStr },
            { $set: { status: "failed" }, $inc: { retryCount: 1 } }
          );

          if (attempt < SUPPLIER_MAX_RETRIES) {
            console.log(`🔄 RETRY START ${fileId} | Attempt ${attempt + 2}`);
            await WebLink.updateOne(
              { fileId, orderId: orderIdStr },
              { $set: { status: "uploading" } }
            );
          } else {
            console.log(`Max retries reached for ${fileId}`);
            failedFiles.push({ fileName: fileId, error: err.message });
            failCount++;
            return { status: "failed", fileName: fileId, error: err.message };
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // 6. Ek ek karke sequential processing (drive me MAX_CONCURRENT = 1 tha)
    // ------------------------------------------------------------------
    const results = [];
    for (let i = 0; i < mediaFiles.length; i++) {
      try {
        const result = await processFile(mediaFiles[i], i);
        results.push(result);
      } catch (err) {
        // processFile ke andar ka unexpected error (jaise DB down) — baaki files chalti rahein
        console.error(`❌ Unexpected error for ${mediaFiles[i].fileId}:`, err.message);
        failCount++;
        failedFiles.push({ fileName: mediaFiles[i].fileId, error: err.message });
        results.push({ status: "failed", fileName: mediaFiles[i].fileId, error: err.message });
      }
    }

    console.log("\n🎉 ALL FILES LOOPED");

    // ------------------------------------------------------------------
    // 7. Final report
    // ------------------------------------------------------------------
    const finalSuccessCount = await WebLink.countDocuments({
      orderId: orderIdStr,
      mainFolderId,
      status: "done",
    });

    console.log("===== FINAL REPORT =====");
    console.log("Total media:", totalMediaFiles);
    console.log("Successfully Uploaded (done in DB):", finalSuccessCount);
    console.log("Failed:", failCount);
    console.log("Failed files:", failedFiles);
    console.log("========================");

    // Last batch face count (drive jaisa: max 5 files tak ki tolerance)
    if (finalSuccessCount >= totalMediaFiles - 5) {
      try {
        console.log("All files uploaded. Starting face count (last batch)...");
        await callFaceApi(true);
      } catch (error) {
        console.error(
          "❌ Face Count API Error:",
          error?.response?.data || error.message
        );
      }
    }

    const updatedOrder = await OrderModel.findOneAndUpdate(
      { order_id: orderDoc.order_id },
      {
        $set: {
          "imageUploadCounts.totalFromDrive": totalMediaFiles,
          "imageUploadCounts.totalWeblink": finalSuccessCount,
          "imageUploadCounts.AllImagesUploadedAt": new Date(),
        },
      },
      { new: true }
    );

    await FolderModel.updateOne(
      { _id: folderId },
      { $set: { status: "done" } }
    );
    console.log(`Folder status set to "done" for mainFolderId: ${mainFolderId}`);

    // ------------------------------------------------------------------
    // 8. WhatsApp (sirf tab jab kuch naya process hua ya folder pehle done nahi tha,
    //    taaki dobara button dabane par customer ko duplicate message na jaye)
    // ------------------------------------------------------------------
    const newlyDoneCount = results.filter((r) => r?.status === "done").length;
    const shouldNotify = !(wasAlreadyDone && newlyDoneCount === 0);

    if (shouldNotify) {
      try {
        const folder = await FolderModel.findById(folderId).lean();
        const updatedOrderId = (updatedOrder?.order_id ?? orderDoc.order_id) + 10800;

        const whatsappLink = folder?.shortCode
          ? `https://horaservices.com/eventcapsule/share/${folder.shortCode}`
          : updatedOrder?.orderWebLink;

        if (updatedOrder?.phone_no) {
          await sendWhatsApp(updatedOrder.phone_no, updatedOrderId, whatsappLink);
        }
      } catch (err) {
        console.error("❌ WhatsApp send error:", err.message);
      }
    } else {
      console.log("ℹ️ Folder was already done and nothing new processed. WhatsApp skipped.");
    }

    return {
      success: true,
      totalMediaFiles,
      successCount: finalSuccessCount,
      failCount,
      failedFiles,
      results,
    };
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


module.exports = { handleDriveFolderUpload, uploadSingleImage, processSupplierS3Folder };
