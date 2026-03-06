const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WebLink = require("../models/weblink-images.js");

const {
  generateThumbnail,
  uploadFileToS3,
  generateVideoPreview,
} = require("../utils/auth.util.js");
const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
const TEMP_DIR = path.join(process.cwd(), "tempUploads");



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
  try{
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
}catch(error){
  console.log("ERROR DOWNLOADING DRIVE ................",error, "URL....... :", url, "DESTINATION .........", dest)
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

  let totalFromDrive = 0;
  let successCount = 0;
  let failCount = 0;

  console.log("mainFolderId in the handler", mainFolderId)
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


  const folderPath = folderName;
  async function processFile(file, retryCount = 0) {
    let filePath, thumbnailPath, clipPath;
    try {
      const originalName = file.name;
      const fileName = `${Date.now()}_${originalName}`;
      filePath = path.join(tempDir, fileName);


      const downloadUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
      console.log(`⬇️ STEP 1 DOWNLOAD STARTED: ${originalName} | Batch: ${file.batch}`);

      await downloadFile(downloadUrl, filePath);

      console.log(`✅ STEP 2   DOWNLOAD COMPLETED: ${originalName} | Batch: ${file.batch}`);

      const isImage = file.mimeType.startsWith("image/");
      const isVideo = file.mimeType.startsWith("video/") || file.name.match(/\.(mp4|mov|mkv|webm)$/i);

      // ================= IMAGE =================
      if (isImage) {
        try {
          thumbnailPath = path.join(
            tempDir,
            `thumb_${fileName.replace(/\.(png|jpeg|jpg)$/i, "")}.webp`
          );

          const uploadOriginal = uploadFileToS3(
            filePath,
            fileName,
            folderPath,
            phoneNo
          );
console.log("STEP 3 GENERATE THUMB START", file.name)

          await generateThumbnail(filePath, thumbnailPath);
console.log("STEP 4 THUMB COMPLETE", file.name)

          const thumbFileName = `thumb_${fileName.replace(
            /\.(png|jpeg|jpg)$/i,
            ""
          )}.webp`;
console.log("STEP 5 S3 UPLOAD START", file.name)

          const uploadThumb = uploadFileToS3(
            thumbnailPath,
            thumbFileName,
            folderPath,
            phoneNo
          );

          const [original, thumb] = await Promise.all([
            uploadOriginal,
            uploadThumb,
          ]);

console.log("STEP 6 S3 UPLOAD COMPLETE", file.name)

          console.log("STEP 7 DB INSERT START", file.name)

          try {
            await WebLink.create({
              orderId: orderId.toString(),
              orderById: customerId,
              orderByName,
              type: "image",

              originalUrl: original.Location,
              originalKey: original.Key,

              thumbnailImageUrl: thumb.Location,
              thumbnailKey: thumb.Key,

              videoClipUrl: null,
              videoClipKey: null,
              mainFolderId,

            });
          }
          catch (error) {
            console.log('create documnet error ------- image -------', error);
          }
          console.log("STEP 8 DB INSERT DONE", file.name)
          successCount++;
          return { type: "image", fileName: originalName };
        }
        catch (error) {
          failCount++;
          console.log('image upload error', error); return { type: "image", fileName: originalName, error: error.message };
        }
      }

      // ================= VIDEO =================
      if (isVideo) {
        clipPath = path.join(tempDir, `clip_${fileName}.mp4`);

        try {
          console.log("STEP 3 GENERATE PREVIEW CLIP START", file.name)

          await generateVideoPreview(filePath, clipPath, 3);

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
            await WebLink.create({
              orderId: orderId.toString(),
              orderById: customerId,
              orderByName,
              type: "video",

              originalUrl: video.Location,
              originalKey: video.Key,

              thumbnailImageUrl: null,
              thumbnailKey: null,

              videoClipUrl: clip.Location,
              videoClipKey: clip.Key,
              mainFolderId

            });
          }
          catch (error) {
            console.log('create documnet error ------- video -------', error);
          }
          console.log("STEP 8 VIDEO DB INSERT DONE", file.name)
          successCount++;
          return { type: "video", fileName: originalName };
        }
        catch (error) {
          failCount++;
          console.log('video upload error', error); return { type: "video", fileName: originalName, error: error.message };
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
    finally {
      [filePath, thumbnailPath, clipPath].forEach((p) => {
        if (p && fs.existsSync(p)) {
          try {
            console.log("DLETE START ------------")
            fs.unlinkSync(p);
            console.log("DELETE SUCCESSFULLY ---------", p)
          }
          catch (error) {
            console.log('error deletng images ------catch ----', error, "filePath", filePath);
          }
        }
      });
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
    let listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')&key=${apiKey}&fields=nextPageToken,files(id,name,mimeType)&pageSize=1`;

    if (pageToken) listUrl += `&pageToken=${pageToken}`;

    const res = await axios.get(listUrl);
    const files = res.data.files || [];
    totalFromDrive += files.length;

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

    while (queue.length > 0 || !finished || activeCount > 0) {

      while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
        const file = queue.shift();
console.log(
  `🚀 START PROCESSING: ${file.name} | Batch: ${file.batch}`
);        activeCount++;

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
  console.log("===== FINAL REPORT =====");
  console.log("Total from Drive:", totalFromDrive);
  console.log("Successfully Uploaded:", successCount);
  console.log("Failed:", failCount);
  console.log("========================");
  // const uploadedFiles = await Promise.all(uploadPromises);
  console.log("uploadedFiles -----------", results);
  console.log("Upload completed for orderId:", orderId);
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
