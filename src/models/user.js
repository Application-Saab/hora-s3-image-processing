const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
    {
        name: { type: String, default: '' },
        firstName: { type: String, default: '' },
        lastName: { type: String, default: '' },
        email: { type: String, index: true },
        avatar: { type: String, default: '' },
        approved: { type: Boolean, default: true },
        role: { type: String, enum: ['admin', 'subadmin', 'customer', 'supplier'], default: 'customer' },
        phone: { type: String, default: '' },
        password: { type: String, default: '' },
        hashpassword: { type: String, default: '' },
        token: { type: String, default: '' },
        os: { type: String, default: 'android' },
        otp: { type: String, default: '' },
        device_token: { type: String, default: '' },
        status: { type: Number, default: '1' /* 1-active 0-inactive 2-delete  */ },
        address: { type: String, default: '' },
        referralCode: { type: String, default: '' },
        vechicle_type: { type: String, default: '' },
        age: { type: String, default: '' },
        city: { type: String, default: '' },
        lat: { type: String, default: '' },
        lng: { type: String, default: '' },
        aadhar_no: { type: String, default: '' },
        aadhar_front_img: { type: String, default: '' },
        aadhar_back_img: { type: String, default: '' },
        experience: { type: String, default: '' },
        userRestaurant: { type: Array, default: [] },
        userServedLocalities: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: "cityServedlocality"
        }],
        job_type: { type: String, default: '1' },/* 1-home 2-restaurant  */
        order_type: { type: String, default: '' },
        job_profile: { type: String, default: '' },
        resume: { type: String, default: '' },
        userDishArray: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: "dish"
        }],
        userCuisioness: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: "Configurations"
        }],
        userAppliance: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: "Configurations"
        }],
        description: { type: String, default: '' },
        is_veg: { type: Boolean, default: true /* false-non veg true-veg  */ },
        // personal field
        isPersonalStatus: { type: Number, default: 0 },
        isProfessionStatus: { type: Number, default: 0 },
        performanceScore: { type: Number, default: 0 },
        performanceBadge: { type: String, enum: ["Elite", "Good", "Average", "Low"], default: "Low" },
        lastRatingUpdate: { type: Date },
        supplierOrderLimit: { type: Number, default: 4 },
        fromWonderland: { type: Boolean, default: false },
        fromCapsule: { type: Boolean, default: false },
        fromWonderlandInternational: { type: Boolean, default: false },
        fromVenue: { type: Boolean, default: false },
        userSpecializations: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: "specialization"
        }],
        about: { type: String, default: '' },
    },
    { strict: false, timestamps: true }
);
userSchema.index({ phone: 1 });

userSchema.index({ phone: 1, createdAt: -1 });
userSchema.index({ fromWonderland: 1, createdAt: -1 });

module.exports = mongoose.model('Users', userSchema)
