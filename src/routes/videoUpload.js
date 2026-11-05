const {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    GetObjectCommand,
    PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { compressVideo, compressVideoInChunks } = require("../utils/auth.util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "photography-hora";

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

const initiateMultipartUpload = async (req, res) => {
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

const completeMultipartUpload = async (req, res) => {
    try {
        const { uploadId, key, parts, fromPanel } = req.body;
        const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

        const completeCommand = new CompleteMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: sortedParts },
        });

        const result = await s3Client.send(completeCommand);

        let compressedKey = null;

        let localOriginal = null;
        let localCompressed = null;
        if (fromPanel === true || fromPanel === "true") {

            const tempDir = os.tmpdir();

            localOriginal = path.join(tempDir, `original_${uploadId}.mp4`);
            localCompressed = path.join(tempDir, `compressed_${uploadId}.mp4`);

            await downloadS3ObjectToFile(key, localOriginal);

            console.log("Original video downloaded successfully");

            await compressVideoInChunks(
                localOriginal,
                localCompressed,
                22,
                "libx265",
                300, 
                2    
            );

            console.log("Video compression completed");
            compressedKey = `${key.replace(/\.[^/.]+$/, "")}_compressed.mp4`;

            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: compressedKey,
                Body: fs.createReadStream(localCompressed),
                ContentType: "video/mp4"
            }));

            console.log("Compressed video uploaded to S3:", compressedKey);
        }

        const fileUrl = result.Location || `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;

        const compressedUrl = compressedKey
            ? `https://${BUCKET_NAME}.s3.amazonaws.com/${compressedKey}`
            : null;

        if (fromPanel === true || fromPanel === "true") {
            await fs.promises.unlink(localOriginal).catch(() => { });
            await fs.promises.unlink(localCompressed).catch(() => { });

            console.log("Temporary video files deleted");
        }

        return res.status(200).json({
            success: true,
            message: 'Video uploaded successfully!',
            originalVideoUrl: fileUrl,
            compressedVideoUrl: compressedUrl,
        });
    } catch (error) {
        console.error('Error completing upload:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    initiateMultipartUpload,
    completeMultipartUpload
};