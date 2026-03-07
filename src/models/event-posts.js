const mongoose = require("mongoose");

const eventPostsSchema = new mongoose.Schema(
  {
    // Common fields
    _id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toString(),
    },
    eventId: {
      type: String,
      ref: "eventInvites",
      required: true,
      trim: true,
    },
    postById: {
      type: String,
      required: true,
      trim: true,
    },
    postByName: {
      type: String,
      required: true,
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
    postType: {
      type: String,
      enum: ["selfUploaded", "thankYouNote", "postBadge", "luckyDraw"],
      required: true,
    },
    likeCounts: {
      type: String,
      default: "0",
    },
    commentCounts: {
      type: String,
      default: "0",
    },

    // Lucky Draw specific
    ticketNumber: {
      type: String,
      trim: true,
      required: function () {
        return this.postType === "luckyDraw";
      },
    },

    // Post Badge specific fields
    badgeId: {
      type: String,
      ref: "badgeMaster",
      required: function () {
        return this.postType === "postBadge";
      },
    },

    taggedUserIds: {
      type: [String],
      default: [],
      validate: {
        validator: function (arr) {
          if (this.postType === "postBadge") {
            return Array.isArray(arr) && arr.length > 0;
          }
          return true;
        },
        message: "At least one tagged user ID is required for postBadge type.",
      },
    },
  },
  {
    timestamps: true,
    versionKey: false, // disables __v
  }
);

module.exports = mongoose.model("event-posts", eventPostsSchema);
