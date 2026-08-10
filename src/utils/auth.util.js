const fs = require("fs"); // for readFileSync
const fsPromise = require("fs").promises;
const sharp = require("sharp");
const AWS = require("aws-sdk");
const multer = require("multer");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
require("dotenv").config();

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
  contentType,
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
    ContentType: contentType || "image/jpeg",
    Metadata: {
      phoneNo: phoneNo,
    },
  };

  // return s3.upload(params).promise();
  try {
    const result = await s3.upload(params).promise();
    console.log("UPLOAD SUCCESS:", fileName);
    return result;
  } catch (err) {
    console.log("❌ S3 UPLOAD ERROR for:", fileName);
    console.log("Status Code:", err.statusCode);
    console.log("Error Code:", err.code);
    console.log("Error Message:", err.message);
    console.log("Full Error:", JSON.stringify(err, null, 2));
    throw err;
  }
};

const uploadFileToS3Wonderland = async ({
  filePath,
  key,
  contentType = "application/octet-stream",
  phoneNo,
}) => {
  const fileStream = fs.createReadStream(filePath);

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: fileStream,
    ContentType: contentType,
    ...(phoneNo && {
      Metadata: {
        phoneNo: String(phoneNo),
      },
    }),
  };

  return s3.upload(params).promise();
};



//delete with retry
const deleteFileWithRetry = async (filePath, retries = 3, delay = 100) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fs.unlinkSync(filePath);
      console.log(`Successfully deleted file: ${filePath}`);
      return;
    } catch (err) {
      console.error(
        `Attempt ${attempt} to delete file ${filePath} failed:`,
        err.message,
      );
      if (attempt === retries) {
        console.error(
          `Failed to delete file ${filePath} after ${retries} attempts`,
        );
        return; // Don't throw error to avoid interrupting the response
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};




// =======================
// Generate Thumbnail
// =======================
const generateThumbnail = async (inputPath, outputPath) => {
  if (inputPath && fs.existsSync(inputPath)){
    console.log("inputPath =====", inputPath, "EXISTS OR NOT ", fs.existsSync(inputPath))
  }
  try {
    // Resize + compress
    const outputBuffer = await sharp(inputPath)
      .resize({ width: 1080, withoutEnlargement: true })
      .rotate()
      .webp({ quality: 80 })
      .withMetadata({ orientation: 1 })
      .toBuffer();

    // Save thumbnail
    await fsPromise.writeFile(outputPath, outputBuffer);

    console.log(
      `Thumbnail saved at: ${outputPath} (Size: ${(
        outputBuffer.length / 1024
      ).toFixed(2)} KB)`,
    );
  } catch (error) {
    console.error("Error generating thumbnail:", error);
    throw error;
  }
};



// Helper function to resize image maintaining aspect ratio
async function resizeImage(inputPath, outputPath, targetWidth) {
  await sharp(inputPath)
    .resize({
      width: targetWidth,
      withoutEnlargement: true // Agar original image width 1080/2160 se chhoti hai toh upscale nahi karega
    })
    .jpeg({ quality: 85 }) // JPEG format with high quality
    .toFile(outputPath);
}

const TEMP_DIR = path.join(process.cwd(), "tempUploads");

// ensure temp folder exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "tempUploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});

const upload = multer({ storage });

try {
  const ffmpegStatic = require("ffmpeg-static");
  if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
} catch (e) {
  // ffmpeg-static not installed — fluent-ffmpeg will try system ffmpeg (/usr/bin/ffmpeg)
}

const generateVideoPreview = (
  inputPath,
  outputPath,
  duration = 4,
  start = 0,
) => {
  return new Promise((resolve, reject) => {
    // ensure output dir exists
    const startTime = Date.now();
    console.log("🎬 Video preview generation started...");

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    ffmpeg(inputPath)
      .setStartTime(start) // start from beginning or a small offset
      .setDuration(duration) // seconds
      .videoCodec("libx264") // re-encode for compatibility & size
      .outputOptions([
        "-crf 28", // quality (higher -> smaller)
        "-preset veryfast", // speed
        "-movflags +faststart", // streaming friendly
        "-pix_fmt yuv420p", // compatibility
        "-an", // remove audio to reduce size (optional)
      ])
      .size("640x?") // scale width to 640, keep aspect
      .on("end", () => {
        const endTime = Date.now();
        const timeTaken = ((endTime - startTime) / 1000).toFixed(2);

        console.log(`✅ Video preview generated in ${timeTaken} seconds`);
        resolve(outputPath);
      })
      .on("error", (err) => {
        const endTime = Date.now();
        const timeTaken = ((endTime - startTime) / 1000).toFixed(2);

        console.log(`❌ Failed after ${timeTaken} seconds Error : ${err}`);
        reject(err);
        throw err;
      })
      .save(outputPath);
  });
};


const formatDuration = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
};

const getVideoDuration = (filePath) => {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error("FFprobe error:", err);
        resolve("");
      } else {
        const duration = metadata?.format?.duration;
        resolve(duration ? formatDuration(parseFloat(duration)) : "");
      }
    });
  });
};

module.exports = {
  uploadFileToS3,
  uploadFileToS3Wonderland,
  generateThumbnail,
  resizeImage,
  generateVideoPreview,
  upload,
  TEMP_DIR,
  deleteFileWithRetry,
  getVideoDuration,
};
