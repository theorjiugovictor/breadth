package store

import "context"

// Load reads one order.
func (s *Store) Load(ctx context.Context, id string) (string, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id FROM orders WHERE id = $1", id)
	var out string
	return out, row.Scan(&out)
}

func unused() {}
