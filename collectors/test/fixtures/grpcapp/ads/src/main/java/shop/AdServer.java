package shop;

public class AdServer {
  static class AdServiceImpl extends AdServiceGrpc.AdServiceImplBase {
    @Override
    public void getAds(AdRequest req, StreamObserver<AdResponse> out) {
      out.onCompleted();
    }
  }
}
