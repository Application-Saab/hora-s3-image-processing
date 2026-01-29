const axios = require("axios");
const fs = require("fs");
const path = require("path");

const {
  generateThumbnail,
  uploadFileToS3,
} = require("../utils/auth.util.js");
const fsPromises = require("fs").promises;


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

async function handleDriveFolderUpload(folderUrl, vendorId,phoneNo,customerId) {
  const folderId = getFolderIdFromUrl(folderUrl);
  if (!folderId) throw new Error("Invalid Google Drive folder URL");
  if (!apiKey) throw new Error("Google Drive API key not configured");
console.log(apiKey)
console.log(folderId)
  // check access
  const isPublic = await isFolderPubliclyAccessible(folderId, apiKey);
  if (!isPublic)
    throw new Error("Google Drive folder link is not publicly accessible");

  const folderName = `${vendorId}`;

  // temp dir
  const tempDir = path.join(__dirname, "uploads");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // list files
  let files = [];
  let pageToken = null;
  do {
    let listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false and mimeType contains 'image/'&key=${apiKey}&fields=nextPageToken,files(id,name,mimeType)`;
    if (pageToken) listUrl += `&pageToken=${pageToken}`;
    const listRes = await axios.get(listUrl);
    files = files.concat(listRes.data.files);
    pageToken = listRes.data.nextPageToken;
  } while (pageToken);

  if (files.length === 0) throw new Error("No images found in the folder");

  const folderPath = `${folderName}_${customerId}`;

  // process files
  const uploadPromises = files.map(async (file) => {
  let filePath;
  let thumbnailPath;

  try {
    const originalName = file.name;
    const fileName = `${Date.now()}_${originalName}`;

    filePath = path.join(tempDir, fileName);
    thumbnailPath = path.join(
      tempDir,
      `thumb_${fileName.replace(/\.(png|jpeg|jpg)$/i, "")}.webp`
    );

    const downloadUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;

    // DOWNLOAD
    await downloadFile(downloadUrl, filePath);

    console.log(`Processing file: ${fileName}`);

    // UPLOAD ORIGINAL
    const s3UploadPromise = uploadFileToS3(
      filePath,
      fileName,
      folderPath,
      phoneNo
    );

    // THUMBNAIL
    await generateThumbnail(filePath, thumbnailPath);

    const thumbFileName = `thumb_${fileName.replace(
      /\.(png|jpeg|jpg)$/i,
      ""
    )}.webp`;

    const s3ThumbPromise = uploadFileToS3(
      thumbnailPath,
      thumbFileName,
      folderPath,
      phoneNo
    );

    const [s3Response, s3ThumbResponse] = await Promise.all([
      s3UploadPromise,
      s3ThumbPromise,
    ]);

    return {
      fileName: originalName,
      fileUrl: s3Response.Location,
      thumbnailUrl: s3ThumbResponse.Location,
    };
  } catch (err) {
    console.error(`Error processing ${file?.name}:`, err.message);
    return { fileName: file?.name, error: err.message };
  } 
finally {
  try {
    if (filePath) {
      await fsPromises.unlink(filePath);
      console.log("Deleted:", filePath);
    }

    if (thumbnailPath) {
      await fsPromises.unlink(thumbnailPath);
      console.log("Deleted:", thumbnailPath);
    }
  } catch (err) {
    console.error("File delete failed:", err.message);
  }
}

});


  const uploadedFiles = await Promise.all(uploadPromises);
  return uploadedFiles
}

module.exports = { handleDriveFolderUpload };
