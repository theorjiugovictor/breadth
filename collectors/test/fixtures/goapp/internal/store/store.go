// Package store keeps orders in Postgres.
package store

import (
	"context"
	"database/sql"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/segmentio/kafka-go"
)

const topic = "order-created"

// Store saves orders.
type Store struct {
	db     *sql.DB
	writer *kafka.Writer
	files  *s3.Client
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db, writer: kafka.NewWriter(kafka.WriterConfig{Topic: topic})}
}

// Save writes an order and announces it.
func (s *Store) Save(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, "INSERT INTO orders (id) VALUES ($1)", id); err != nil {
		return err
	}
	s.archive(ctx, id)
	return s.writer.WriteMessages(ctx, kafka.Message{Value: []byte(id)})
}

func (s *Store) archive(ctx context.Context, id string) {
	s.files.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(os.Getenv("ARCHIVE_BUCKET")), Key: aws.String(id)})
}
