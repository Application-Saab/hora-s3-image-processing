const fs = require("fs");                 // for readFileSync
const fsPromises = require("fs").promises; // for writeFile
const sharp = require("sharp");
const AWS = require("aws-sdk");

// AWS S3 config
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// =======================
// Upload file to S3
// =======================
const uploadFileToS3 = async (
  filePath,
  fileName,
  folderPath,
  phoneNo,
  contentType
) => {
  const fileContent = fs.readFileSync(filePath);

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `${folderPath}/${fileName}`,
    Body: fileContent,
    ContentType: contentType || "image/jpeg",
    Metadata: {
      phoneNo: String(phoneNo || ""),
    },
  };

  return s3.upload(params).promise();
};

// =======================
// Generate Thumbnail
// =======================
const generateThumbnail = async (inputPath, outputPath) => {
  try {
    // Resize + compress
    const outputBuffer = await sharp(inputPath)
      .rotate()
      .webp({ quality: 50 })
      .withMetadata({ orientation: 1 })
      .toBuffer();

    // If still >100KB, compress more
    const finalBuffer =
      outputBuffer.length > 100 * 1024
        ? await sharp(outputBuffer).webp({ quality: 30 }).toBuffer()
        : outputBuffer;

    // Save thumbnail
    await fsPromises.writeFile(outputPath, finalBuffer);

    console.log(
      `Thumbnail saved at: ${outputPath} (Size: ${(
        finalBuffer.length / 1024
      ).toFixed(2)} KB)`
    );
  } catch (error) {
    console.error("Error generating thumbnail:", error.message);
    throw error;
  }
};

module.exports = {
  uploadFileToS3,
  generateThumbnail,
};
