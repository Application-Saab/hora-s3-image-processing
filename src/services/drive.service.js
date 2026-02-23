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
  const folderId = getFolderIdFromUrl(folderUrl);
  if (!folderId) throw new Error("Invalid Google Drive folder URL");
  if (!apiKey) throw new Error("Google Drive API key not configured");

  const isPublic = await isFolderPubliclyAccessible(folderId, apiKey);
  if (!isPublic) {
    throw new Error("Google Drive folder link is not publicly accessible");
  }

const folderName = `${orderId}_${customerId}_${phoneNo}`;
  const orderByName = phoneNo || "";

  // temp dir
  if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

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
      filePath = path.join(TEMP_DIR, fileName);


      const downloadUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
      await downloadFile(downloadUrl, filePath);

      const isImage = file.mimeType.startsWith("image/");
      const isVideo = file.mimeType.startsWith("video/") || file.name.match(/\.(mp4|mov|mkv|webm)$/i);

      // ================= IMAGE =================
      if (isImage) {
       thumbnailPath = path.join(
  TEMP_DIR,
  `thumb_${fileName.replace(/\.(png|jpeg|jpg)$/i, "")}.webp`
);

        const uploadOriginal = uploadFileToS3(
          filePath,
          fileName,
          folderPath,
          phoneNo
        );

        await generateThumbnail(filePath, thumbnailPath);

        const thumbFileName = path.basename(thumbnailPath);

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
try{
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
      catch(error){
        console.log('create documnet error ------- image -------',error);
      }

        return { type: "image", fileName: originalName };
      }

      // ================= VIDEO =================
      if (isVideo) {
        clipPath = path.join(TEMP_DIR, `clip_${fileName}.mp4`);

        try{
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
try{
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
      catch(error){
        console.log('create documnet error ------- video -------',error);
      }

        return { type: "video", fileName: originalName };
    }
    catch(error){
      console.log('video upload error', error);  return { type: "video", fileName: originalName, error: error.message };

    }
      }
    } catch (err) {
      console.error(`Error processing ${file?.name}:`, err.message);
      return { fileName: file?.name, error: err.message };
    } finally {
      [filePath, thumbnailPath, clipPath].forEach((p) => {
        if (p && fs.existsSync(p)) {
          try{
          fs.unlinkSync(p);
          }
          catch(error){
console.log('error deletng images ------catch ----',error);
          }
        }
      });
    }
  });

  const uploadedFiles = await Promise.all(uploadPromises);
  console.log(uploadedFiles);
  return uploadedFiles;
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
