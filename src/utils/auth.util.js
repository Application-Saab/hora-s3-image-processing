const fs = require("fs");                 // for readFileSync
const fsPromises = require("fs").promises; // for writeFile
const sharp = require("sharp");
const AWS = require("aws-sdk");
const multer = require("multer");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");


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
    ContentType: contentType || "application/octet-stream",
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

const TEMP_DIR = path.join(process.cwd(), "tempUploads");

// ensure temp folder exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR); // ← uploads/ → tempUploads/
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname
      .replace(/\s+/g, "_")       // spaces → underscore
      .replace(/[()]/g, "");      // remove brackets
    cb(null, `${Date.now()}-${safeName}`);
  },
});


const fileFilter = (req, file, cb) => {
  if (
    file.mimetype.startsWith("image/") ||
    file.mimetype.startsWith("video/")
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only image and video files allowed"), false);
  }
};


const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 10MB
  },
});


const generateVideoPreview = (inputPath, outputPath, duration = 4, start = 0) => {
  return new Promise((resolve, reject) => {
    // ensure output dir exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    ffmpeg(inputPath)
      .setStartTime(start)               // start from beginning or a small offset
      .setDuration(duration)             // seconds
      .videoCodec('libx264')             // re-encode for compatibility & size
      .outputOptions([
        '-crf 28',                       // quality (higher -> smaller)
        '-preset veryfast',              // speed
        '-movflags +faststart',          // streaming friendly
        '-pix_fmt yuv420p',              // compatibility
        '-an'                            // remove audio to reduce size (optional)
      ])
      .size('640x?')                     // scale width to 640, keep aspect
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
};


module.exports = {
  uploadFileToS3,
  generateThumbnail,
  generateVideoPreview,
  upload,
  TEMP_DIR,
};
