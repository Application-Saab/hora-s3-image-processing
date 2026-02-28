const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WebLink = require("../models/weblink-images.js");

const {
  generateThumbnail,
  uploadFileToS3,
  generateVideoPreview,
} = require("../utils/auth.util.js");
const fsPromises = require("fs").promises;


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
}

async function handleDriveFolderUpload(
  folderUrl,
  vendorId,
  phoneNo,
  customerId,
  orderId,
  mainFolderId
) {
  console.log("mainFolderId in the handler",mainFolderId)
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

  // 📂 list image + video
  let files = [];
  let pageToken = null;
  do {
    let listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')&key=${apiKey}&fields=nextPageToken,files(id,name,mimeType)`;
    if (pageToken) listUrl += `&pageToken=${pageToken}`;
    const listRes = await axios.get(listUrl);
    files = files.concat(listRes.data.files);
    pageToken = listRes.data.nextPageToken;
  } while (pageToken);

  if (!files.length) throw new Error("No files found");

  const folderPath = folderName;

  const uploadPromises = files.map(async (file) => {
    let filePath, thumbnailPath, clipPath;

    try {
      const originalName = file.name;
      const fileName = `${Date.now()}_${originalName}`;
      filePath = path.join(tempDir, fileName);


      const downloadUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
      await downloadFile(downloadUrl, filePath);

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

          await generateThumbnail(filePath, thumbnailPath);

          const thumbFileName = `thumb_${fileName.replace(
            /\.(png|jpeg|jpg)$/i,
            ""
          )}.webp`;

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

          return { type: "image", fileName: originalName };
        }
        catch (error) {
          console.log('image upload error', error); return { type: "image", fileName: originalName, error: error.message };
        }
      }

      // ================= VIDEO =================
      if (isVideo) {
        clipPath = path.join(tempDir, `clip_${fileName}.mp4`);

        try {
          await generateVideoPreview(filePath, clipPath, 3);

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

          return { type: "video", fileName: originalName };
        }
        catch (error) {
          console.log('video upload error', error); return { type: "video", fileName: originalName, error: error.message };
        }
      }
    } catch (err) {
      console.error(`Error processing ${file?.name}:`, err.message);
      return { fileName: file?.name, error: err.message };
    } finally {
      [filePath, thumbnailPath, clipPath].forEach((p) => {
        if (p && fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          }
          catch (error) {
            console.log('error deletng images ------catch ----', error, "filePath", filePath);
          }
        }
      });
    }
  });

  const uploadedFiles = await Promise.all(uploadPromises);
  console.log("uploadedFiles -----------",uploadedFiles);
  console.log("Upload completed for orderId:", orderId);
  return uploadedFiles;
}



console.log("hello")
//batch processing 

async function handleDriveFolderUploadBatch(
  folderUrl,
  vendorId,
  phoneNo,
  customerId,
  orderId,
  mainFolderId
) {
  const folderId = getFolderIdFromUrl(folderUrl);
  if (!folderId) throw new Error("Invalid Google Drive folder URL");
  if (!apiKey) throw new Error("Google Drive API key not configured");

  const isPublic = await isFolderPubliclyAccessible(folderId, apiKey);
  if (!isPublic) throw new Error("Google Drive folder link is not publicly accessible");

  const folderName = `${orderId}_${customerId}_${phoneNo}`;
  const orderByName = phoneNo || ""; // store this properly

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const MAX_BATCH = 10;
  const pageSize = MAX_BATCH;
  let pageToken = null;
  const uploadQueue = [];
  let activeUploads = 0;
  let completedCount = 0;
  let failedCount = 0;

  // ---------------- FETCH BATCH FROM DRIVE ----------------
  async function fetchNextBatch() {
    let listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')&key=${apiKey}&fields=nextPageToken,files(id,name,mimeType)&pageSize=${pageSize}`;
    if (pageToken) listUrl += `&pageToken=${pageToken}`;

    const listRes = await axios.get(listUrl);
    pageToken = listRes.data.nextPageToken;

    if (listRes.data.files && listRes.data.files.length) {
      uploadQueue.push(...listRes.data.files);
      console.log(`Fetched ${listRes.data.files.length} files from Drive. Queue length: ${uploadQueue.length}`);
    }

    return !!pageToken;
  }

  // ---------------- PROCESS NEXT ----------------
  async function processNext() {

    if (activeUploads >= MAX_BATCH) return;

    if (!uploadQueue.length && pageToken) {
      const moreFiles = await fetchNextBatch();
      if (!moreFiles && !uploadQueue.length && activeUploads === 0) {
        console.log(
          `\nAll processing done. Completed: ${completedCount}, Failed: ${failedCount}`
        );
        return;
      }
    }

    if (!uploadQueue.length) return; // wait if fetching batch

    const file = uploadQueue.shift();
    activeUploads++;
    console.log(`\nSTART processing: ${file.name} | Active uploads: ${activeUploads}`);

    try {
      const result = await processSingleFile(file, folderName, phoneNo, customerId, orderId, mainFolderId, orderByName);
      completedCount++;
      console.log(`✔ COMPLETED: ${file.name} | Type: ${result.type}`);
    } catch (err) {
      failedCount++;
      console.log(`❌ FAILED: ${file.name} | Error: ${err.message}`);
    } finally {
      activeUploads--;
      processNext();
    }

    processNext();
  }

  // ---------------- PROCESS SINGLE FILE ----------------
  async function processSingleFile(file, folderPath, phoneNo, customerId, orderId, mainFolderId, orderByName, maxRetries = 3) {
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;
      console.log(`Processing ${file.name} | Attempt ${attempt}`);

      let filePath, thumbnailPath, clipPath;

      try {
        const originalName = file.name;
        const fileName = `${Date.now()}_${originalName}`;
        filePath = path.join(TEMP_DIR, fileName);

        // download from Drive
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${apiKey}`;
        await downloadFile(downloadUrl, filePath);
        console.log(`Download complete: ${file.name}`);

        const isImage = file.mimeType.startsWith("image/");
        const isVideo = file.mimeType.startsWith("video/") || file.name.match(/\.(mp4|mov|mkv|webm)$/i);

        // ---------------- IMAGE ----------------
        if (isImage) {
          thumbnailPath = path.join(TEMP_DIR, `thumb_${fileName.replace(/\.(png|jpeg|jpg)$/i, "")}.webp`);

          try {
            const uploadOriginal = uploadFileToS3(filePath, fileName, folderPath, phoneNo);
            await generateThumbnail(filePath, thumbnailPath);
            const uploadThumb = uploadFileToS3(path.resolve(thumbnailPath), path.basename(thumbnailPath), folderPath, phoneNo);

            const [original, thumb] = await Promise.all([uploadOriginal, uploadThumb]);

            await WebLink.create({
              orderId: orderId.toString(),
              orderById: customerId,
              orderByName, // <-- store properly
              type: "image",
              originalUrl: original.Location,
              originalKey: original.Key,
              thumbnailImageUrl: thumb.Location,
              thumbnailKey: thumb.Key,
              videoClipUrl: null,
              videoClipKey: null,
              mainFolderId,
            });

            return { type: "image", fileName: originalName };
          } catch (err) {
            console.error(`Image Upload/Mongo Error: ${file.name} | Attempt ${attempt} | ${err.message}`);
            if (attempt >= maxRetries) throw err;
            else continue; // retry
          }
        }

        // ---------------- VIDEO ----------------
        if (isVideo) {
          clipPath = path.join(TEMP_DIR, `clip_${fileName}.mp4`);
          await generateVideoPreview(filePath, clipPath, 3);

          try {
            const uploadVideo = uploadFileToS3(filePath, fileName, folderPath, phoneNo, file.mimeType);
            const uploadClip = uploadFileToS3(clipPath, path.basename(clipPath), folderPath, phoneNo, "video/mp4");

            const [video, clip] = await Promise.all([uploadVideo, uploadClip]);

            await WebLink.create({
              orderId: orderId.toString(),
              orderById: customerId,
              orderByName, // <-- store properly
              type: "video",
              originalUrl: video.Location,
              originalKey: video.Key,
              thumbnailImageUrl: null,
              thumbnailKey: null,
              videoClipUrl: clip.Location,
              videoClipKey: clip.Key,
              mainFolderId,
            });

            return { type: "video", fileName: file.name };
          } catch (err) {
            console.error(`Video Upload/Mongo Error: ${file.name} | Attempt ${attempt} | ${err.message}`);
            if (attempt >= maxRetries) throw err;
            else continue; // retry
          }
        }
      } finally {
        // cleanup
        [filePath, thumbnailPath, clipPath].forEach((p) => {
          if (p && fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch { }
          }
        });
      }
    }
  }

  // ---------------- START ----------------
  // initial batch fetch
  await fetchNextBatch();
  for (let i = 0; i < MAX_BATCH; i++) processNext();
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
