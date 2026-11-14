const {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { compressVideoInChunks } = require("../utils/auth.util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "photography-hora";

/* ---------------- Time log helpers ---------------- */

const formatMs = (ms) => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
};

const createTimer = (label) => {
    const startedAt = Date.now();
    let lastStep = startedAt;

    return {
        step: (message) => {
            const now = Date.now();
            console.log(
                `⏱️ [${label}] ${message} | step: ${formatMs(now - lastStep)} | total: ${formatMs(now - startedAt)}`
            );
            lastStep = now;
        },
        total: () => Date.now() - startedAt,
    };
};

/* ---------------- S3 download ---------------- */

const downloadS3ObjectToFile = async (key, filePath) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });

    const response = await s3Client.send(command);

    await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(filePath);

        response.Body.pipe(writeStream);

        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        response.Body.on("error", reject);
    });
};

/* ---------------- Initiate multipart ---------------- */

const initiateMultipartUpload = async (req, res) => {
    console.log("start")
    try {
        const { fileName, fileType, totalChunks, folderName = "video_uploads" } = req.body;

        const key = `${folderName}/${fileName}`;

        const createCommand = new CreateMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: fileType,
        });

        const multipartUpload = await s3Client.send(createCommand);
        const uploadId = multipartUpload.UploadId;

        const presignedUrls = [];
        for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
            const uploadPartCommand = new UploadPartCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
            });

            const url = await getSignedUrl(s3Client, uploadPartCommand, { expiresIn: 3600 });
            presignedUrls.push(url);
        }

        return res.status(200).json({
            success: true,
            uploadId,
            key,
            presignedUrls,
        });
    } catch (error) {
        console.error("Error initiating upload:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/* ---------------- Complete multipart + compress ---------------- */

const completeMultipartUpload = async (req, res) => {
    // Compression lamba chalta hai, isliye request timeout band kar do
    req.setTimeout(0);
    res.setTimeout(0);

    const { uploadId, key, parts, fromPanel } = req.body;
    const isPanel = fromPanel === true || fromPanel === "true";

    const timer = createTimer(key);
    let localOriginal = null;
    let localCompressed = null;

    try {
        console.log(`🚀 [${key}] Complete request received | fromPanel: ${isPanel}`);

        const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

        const result = await s3Client.send(
            new CompleteMultipartUploadCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                UploadId: uploadId,
                MultipartUpload: { Parts: sortedParts },
            })
        );
        timer.step("✅ S3 multipart merge complete (original video ready)");

        const fileUrl =
            result.Location || `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;

        let compressedUrl = null;

        if (isPanel) {
            const tempDir = os.tmpdir();
            const safeId = String(uploadId).replace(/[^a-zA-Z0-9]/g, "").slice(-24);

            localOriginal = path.join(tempDir, `original_${safeId}.mp4`);
            localCompressed = path.join(tempDir, `compressed_${safeId}.mp4`);

            // 1) Download
            await downloadS3ObjectToFile(key, localOriginal);
            const originalSizeMB = (fs.statSync(localOriginal).size / (1024 * 1024)).toFixed(1);
            timer.step(`⬇️ Original downloaded from S3 (${originalSizeMB} MB)`);

            // 2) Compress (chunks + merge ke andar ke logs utils me aayenge)
            await compressVideoInChunks(
                localOriginal,
                localCompressed,
                26,          
                "libx264",   
                300,         
                2,           
                "veryfast"   
            );

            const compressedSizeMB = (fs.statSync(localCompressed).size / (1024 * 1024)).toFixed(1);
            timer.step(`🎞️ Compression finished (${originalSizeMB} MB → ${compressedSizeMB} MB)`);

            // 3) Upload compressed to S3
            const compressedKey = `${key.replace(/\.[^/.]+$/, "")}_compressed.mp4`;

            await new Upload({
                client: s3Client,
                params: {
                    Bucket: BUCKET_NAME,
                    Key: compressedKey,
                    Body: fs.createReadStream(localCompressed),
                    ContentType: "video/mp4",
                },
                queueSize: 4,
                partSize: 25 * 1024 * 1024,
            }).done();
            timer.step(`⬆️ Compressed video uploaded to S3: ${compressedKey}`);

            compressedUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${compressedKey}`;
        }

        console.log(`🏁 [${key}] ALL DONE | Total time: ${formatMs(timer.total())}`);

        return res.status(200).json({
            success: true,
            message: "Video uploaded successfully!",
            originalVideoUrl: fileUrl,
            compressedVideoUrl: compressedUrl,
        });
    } catch (error) {
        console.error(`❌ [${key}] Error after ${formatMs(timer.total())}:`, error);
        return res.status(500).json({ success: false, message: error.message });
    } finally {
        if (localOriginal) await fs.promises.unlink(localOriginal).catch(() => { });
        if (localCompressed) await fs.promises.unlink(localCompressed).catch(() => { });
        if (isPanel) console.log(`🧹 [${key}] Temporary files deleted`);
    }
};

module.exports = {
    initiateMultipartUpload,
    completeMultipartUpload,
};