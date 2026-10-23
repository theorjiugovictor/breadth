"""Refund receipts, kept in S3."""
import os

import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["RECEIPTS_BUCKET"]


def store_receipt(refund_id, customer, amount):
    body = f"Refund {refund_id} for {customer}: {amount:.2f}".encode()
    s3.put_object(Bucket=BUCKET, Key=f"refunds/{refund_id}.txt", Body=body)
