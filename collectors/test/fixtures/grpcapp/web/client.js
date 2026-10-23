const grpc = require("@grpc/grpc-js");
const shop = grpc.loadPackageDefinition(def).shop;

const cart = new shop.CartService("cart:7070", grpc.credentials.createInsecure());
const ads = new shop.AdService("ads:9555", grpc.credentials.createInsecure());

function addToCart(item) {
  cart.addItem({ item }, () => {});
}

function showAds() {
  ads.getAds({}, () => {});
}

module.exports = { addToCart, showAds };
