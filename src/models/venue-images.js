const mongoose = require("mongoose");

const venueImagesSchema = new mongoose.Schema(
  {
    venueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "eventInvites",
      required: true,
      trim: true,
    },
    // fileId: {
    //   type: String,
    // //   unique: true,
    // //   sparse: true,
    // default: '',
    // },
    // status: {
    //   type: String,
    //   enum: ["uploading", "done", "failed"],
    //   default: "done",
    // },
    postById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      required: true,
      trim: true,
    },
    // retryCount: {
    //   type: Number,
    //   default: 0,
    // },
    postByName: {
      type: String,
      //   required: true,
      trim: true,
    },
    postUrl: {
      type: String,
      required: true,
      trim: true,
    },
    postKey: {
      type: String,
      required: true,
      trim: true,
    },
    postWebpUrl: {
      type: String,
      required: true,
      trim: true,
    },
    postWebpKey: {
      type: String,
      required: true,
      trim: true,
    },
    // postType: {
    //   type: String,
    //   enum: ["selfUploaded", "thankYouNote", "postBadge", "luckyDraw"],
    //   required: true,
    // },
    // likeCounts: {
    //   type: String,
    //   default: "0",
    // },
    // commentCounts: {
    //   type: String,
    //   default: "0",
    // },

    folderIds: {
      type: [String],
      default: [],
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false, // disables __v
  },
);

module.exports = mongoose.model("venue-images", venueImagesSchema);
