const { uploadFileToS3Wonderland } = require("./auth.util");

const uploadImage = ({ filePath, folderPath, mimeType, isThumb }) => {
  const originalResp = uploadFileToS3Wonderland({
    filePath,
    key: folderPath,
    contentType: mimeType,
  });
  const thumbResp = isThumb
    ? uploadFileToS3Wonderland({
        filePath,
        key: folderPath.replace(/(\.[\w\d_-]+)$/i, "_thumb$1"),
        contentType: mimeType,
      })
    : null;
  return { original: originalResp, thumb: thumbResp };
};

const uploadVideo = ({ filePath, folderPath, mimeType, isThumb }) => {
  const originalResp = uploadFileToS3Wonderland({
    filePath,
    key: folderPath,
    contentType: mimeType,
  });
  const thumbResp = isThumb
    ? uploadFileToS3Wonderland({
        filePath,
        key: folderPath.replace(/(\.[\w\d_-]+)$/i, "_thumb$1"),
        contentType: mimeType,
      })
    : null;
  return { original: originalResp, thumb: thumbResp };
};

const handleMediaUpload = async ({ file, isThumb }) => {
  const { filePath, mimetype, filename } = file;
  const isVideo = mimetype.startsWith("video/");
  if (isVideo) {
    return uploadVideo({ filePath, folderPath: filename, mimeType: mimetype, isThumb });
  }
  return uploadImage({ filePath, folderPath: filename, mimeType: mimetype, isThumb });
};

module.exports = {
  uploadImage,
  uploadVideo,
};
