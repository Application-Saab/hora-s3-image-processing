
const fs = require("fs");
const path = require("path");

const {
  compressVideo,
} = require("../utils/auth.util.js");

const TEMP_DIR = path.join(process.cwd(), "tempUploads");
const INPUT_DIR = path.join(process.cwd(), "testVideos");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Sirf Ek Variant Par Test Karne Ke Liye (Senior Recommendation)
const testVariants = [
  {
    codec: "libx265",
    crf: 24,
    name: "H265_CRF24_1080p",
  },
];

async function testVideo() {
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((file) =>
      /\.(mp4|mov|mkv|webm)$/i.test(file)
    );

  if (!files.length) {
    console.log("❌ No video found in testVideos folder");
    return;
  }

  const inputFile = files[0];
  const inputPath = path.join(INPUT_DIR, inputFile);

  console.log("\n=================================");
  console.log("🎬 OPTIMIZED COMPRESSION TEST");
  console.log("=================================");

  console.log("Input:", inputPath);

  const originalStats = fs.statSync(inputPath);
  const originalSizeMB = originalStats.size / 1024 / 1024;

  console.log(
    `📦 ORIGINAL SIZE: ${originalSizeMB.toFixed(2)} MB`
  );

  const baseName = path.parse(inputFile).name;
  const results = [];

  for (const variant of testVariants) {
    const outputFileName = `${baseName}_${variant.name}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFileName);

    console.log(`\n🚀 Testing: ${variant.name}...`);

    try {
      await compressVideo(
        inputPath,
        outputPath,
        variant.crf,
        variant.codec
      );

      const outputStats = fs.statSync(outputPath);
      const sizeMB = outputStats.size / 1024 / 1024;
      const reduction = (
        ((originalSizeMB - sizeMB) / originalSizeMB) *
        100
      ).toFixed(1);

      results.push({
        Variant: variant.name,
        Codec: variant.codec,
        CRF: variant.crf,
        SizeMB: sizeMB.toFixed(2) + " MB",
        Reduction: `${reduction}%`,
        File: outputFileName,
      });
    } catch (err) {
      console.log(
        `⚠️ Skipping ${variant.name}: Codec non-supported or failed (${err.message})`
      );
    }
  }

  console.log("\n=================================");
  console.log("📊 FINAL COMPARISON TABLE");
  console.log("=================================");

  console.table(results);

  console.log("\n📁 Compressed files saved in:");
  console.log(TEMP_DIR);
}

testVideo().catch((error) => {
  console.error("❌ TEST ERROR:", error);
});