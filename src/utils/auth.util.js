const fs = require("fs");                 // for readFileSync
const fsPromise = require('fs').promises;
const sharp = require("sharp");
const AWS = require("aws-sdk");
const multer = require("multer");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
require('dotenv').config();


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
  console.log("Uploading to S3:", fileName);

if (fs.existsSync(filePath)) {
  const stats = fs.statSync(filePath);
  console.log("Upload file size (KB):", (stats.size / 1024).toFixed(2));
}

  const fileContent = fs.readFileSync(filePath);

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `${folderPath}/${fileName}`,
    Body: fileContent,
    ContentType: contentType || 'image/jpeg',
    Metadata: {
      phoneNo: phoneNo,
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
        ? await sharp(outputBuffer).webp({ quality: 1 }).toBuffer()
        : outputBuffer;

    // Save thumbnail
    await fsPromise.writeFile(outputPath, finalBuffer);

    console.log(
      `Thumbnail saved at: ${outputPath} (Size: ${(
        finalBuffer.length / 1024
      ).toFixed(2)} KB)`
    );
  } catch (error) {
    console.error("Error generating thumbnail:", error);
  }
};

const TEMP_DIR = path.join(process.cwd(), "tempUploads");

// ensure temp folder exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'tempUploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}_${file.originalname}`);
    }
});


const upload = multer({storage});



try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
} catch (e) {
  // ffmpeg-static not installed — fluent-ffmpeg will try system ffmpeg (/usr/bin/ffmpeg)
}

const generateVideoPreview = (inputPath, outputPath, duration = 4, start = 0) => {
  return new Promise((resolve, reject) => {
    // ensure output dir exists
    const startTime = Date.now();  
        console.log("🎬 Video preview generation started...");

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
      .on('end', () => {
        const endTime = Date.now();
        const timeTaken = ((endTime - startTime) / 1000).toFixed(2);

        console.log(`✅ Video preview generated in ${timeTaken} seconds`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        const endTime = Date.now();
        const timeTaken = ((endTime - startTime) / 1000).toFixed(2);

        console.log(`❌ Failed after ${timeTaken} seconds Error : ${err}`);
        reject(err);
      })
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
