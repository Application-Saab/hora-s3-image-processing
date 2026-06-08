const mongoose = require("mongoose");

const venueImagesSchema = new mongoose.Schema(
  {
    venueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "eventInvites",
      required: true,
      trim: true,
    },
    postById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      required: true,
      trim: true,
    },
    postByName: {
      type: String,
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

    folderIds: {
      type: [String],
      default: [],
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

module.exports = mongoose.model("venue-images", venueImagesSchema);
