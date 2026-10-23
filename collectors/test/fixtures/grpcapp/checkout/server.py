import grpc
import shop_pb2_grpc


class BaseCheckout(shop_pb2_grpc.CheckoutServiceServicer):
    def Check(self, request, context):
        return None


class Checkout(BaseCheckout):
    def PlaceOrder(self, request, context):
        channel = grpc.insecure_channel("cart:7070")
        cart = shop_pb2_grpc.CartServiceStub(channel)
        items = cart.GetCart(request)
        return items
