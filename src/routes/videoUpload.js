const {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "photography-hora";

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
        const { uploadId, key, parts } = req.body;
        const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

        const completeCommand = new CompleteMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: sortedParts },
        });

        const result = await s3Client.send(completeCommand);

        const fileUrl = result.Location || `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;

        return res.status(200).json({
            success: true,
            message: 'Video uploaded successfully!',
            videoUrl: fileUrl,
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