package com.shop.orders;

import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.SendMessageRequest;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;

public class ReceiptStore {
  private static final String BUCKET = "shop-receipts";
  private final S3Client s3 = S3Client.create();
  private final SqsClient sqs = SqsClient.create();
  private final String queueUrl = System.getenv("RECEIPTS_QUEUE_URL");

  public void save(String id, byte[] pdf) {
    s3.putObject(PutObjectRequest.builder().bucket(BUCKET).key(id).build(), RequestBody.fromBytes(pdf));
  }

  public byte[] load(String id) {
    return s3.getObjectAsBytes(b -> b.bucket(BUCKET).key(id)).asByteArray();
  }

  public void announce(String id) {
    SendMessageRequest req = SendMessageRequest.builder().queueUrl(System.getenv("RECEIPTS_QUEUE_URL")).messageBody(id).build();
    sqs.sendMessage(req);
  }

  public void index(DynamoDbEnhancedClient enhanced, Receipt r) {
    DynamoDbTable<Receipt> table = enhanced.table("receipts", TableSchema.fromBean(Receipt.class));
    table.putItem(r);
  }
}
