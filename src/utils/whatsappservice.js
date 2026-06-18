const axios = require("axios");

const sendWhatsApp = async (mobile, orderId, link) => {
    console.log("=================================");
    console.log("[WHATSAPP SEND START]");

    let formatted = mobile.toString().startsWith("+91")
        ? mobile.toString()
        : "+91" + mobile.toString();

    const payload = {
        messages: [
            {
                from: "+917338584828",
                to: formatted,
                content: {
                    templateName: "weblink",
                    language: "en",
                    templateData: {
                        body: {
                            placeholders: [
                                String(orderId), // Order status
                                String(link)     // Source
                            ]
                        }
                    }
                }
            }
        ]
    };

    try {
        const res = await axios.post(
            "https://public.doubletick.io/whatsapp/message/template",
            payload,
            {
                headers: {
                    accept: "application/json",
                    "content-type": "application/json",
                    Authorization: "key_fHOm5tEzbfSWRbC29LoZkYd0vpqaU7B22Q2iSL2vgawcN3k0D75iXNSPRen3ie7Qj3L7C6r5EhH4lLYeL1dCtPj9WyQ9wPm2abK1wltW8bYXVR5xvjLfPeQgfRld3ws1lkkRduX6tfrHbmYnbhbYnau3HSfJAylSmBso4m5qjO7vm4YjbhtqMbdkNK2EoNPXqM5SdxThyeGvSlvoA8JCVhGvL98yrocJJ7JfhBasgsEnN7qArGvPdsswdhys"
                }
            }
        );

        console.log(JSON.stringify(res.data, null, 2));
        return true;
    } catch (err) {
        console.log(err?.response?.data || err.message);
        return false;
    }
};

module.exports = { sendWhatsApp };
