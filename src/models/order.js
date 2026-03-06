const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    order_date: { type: Date, default: '' },
    order_time: { type: String, default: '' },
    job_start_time: { type: String, default: '' },
    job_end_time: { type: String, default: '' },
    no_of_people: { type: Number, default: 0 },
    no_of_burner: { type: Number, default: 0 },
    type: { type: Number, default: 4 /* 1-bartender,2-helper,3-waiter,4-deliver */ },
    order_type: { type: Boolean, default: true /* true-veg,false-non_veg */ },
    items: { type: Array, default: '' },
    total_amount: { type: Number, default: '' },
    is_gst: { type: Number, default: '' },
    is_discount: { type: Number, default: '' },
    payable_amount: { type: Number, default: '' },
    addressId: { type: mongoose.Schema.Types.ObjectId, ref: "address", required: true },
    fromId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
    toId: { type: String, default: '' },
    status: { type: Number, default: 1 /* 1-active 0-inactive 2-delete  */ },
    order_status: { type: Number, default: 0 /* 0-Booking ,1-Accepted ,2-pending/in-progress, 3-delivery/completed, 4-failed, 5- handle -> {1,2,3}, 6- expire  */ },
    otp: { type: Number, default: 0 },
    order_id: { type: Number, default: 0 },
    supplierUserIds: { type: Array, default: [] },
    orderApplianceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Configurations" }],
    categoryIds: { type: Array, default: [] },
    selecteditems: [{ type: mongoose.Schema.Types.ObjectId, ref: "dish" }],
    chef: { type: Number, default: 1 },
    helper: { type: Number, default: 0 },
    order_feedback: { type: String, default: "0" /* 0-no data,1-data present */ },
    userOrderDishImageArray: { type: Array, default: [] },
    userReviewRatingArray: { type: Array, default: [] },
    rateofCleanliness: { type: String, default: "" },
    comments: { type: String, default: '' },
    review_date: { type: Date, default: '' },
    review_time: { type: String, default: '' },
    order_complete_date: { type: String, default: '' },
    order_locality: { type: String, default: '' },
    order_pincode: { type: String, default: '' },
    decoration_comments: { type: String, default: '' },
    add_on: {type: Array,default: []},
    phone_no: { type: String, default: '' },
    online_phone_no: { type: String, default: '' },
    advance_amount: { type: String, default: '' },
    balance_amount: { type: String, default: '' },
    vendor_amount: { type: String, default: '' },
    order_taken_by: { type: String, default: '' },
    eventName: { type: String, default: '' },
    call_checklist: { type: Object, default: {} },
    call_checklist_exists: { type: Boolean, default: false },
imageUploadCounts: {
  type: {
    totalFromDrive: { type: Number, default: 0 },
    totalWeblink: { type: Number, default: 0 }
  },
  default: {}
}
}, {
    strict: false,
    timestamps: true
});

module.exports = mongoose.model('order', orderSchema)
