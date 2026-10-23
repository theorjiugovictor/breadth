package main

import (
	"database/sql"
	"net/http"

	"github.com/acme/goapp/internal/store"
)

var orders *store.Store

func main() {
	db, _ := sql.Open("postgres", "")
	orders = store.NewStore(db)
	http.HandleFunc("POST /orders", createOrder)
	http.HandleFunc("GET /orders/{id}", getOrder)
	http.ListenAndServe(":8080", nil)
}

func createOrder(w http.ResponseWriter, r *http.Request) {
	for _, id := range []string{r.FormValue("id")} {
		orders.Save(r.Context(), id)
	}
}

func getOrder(w http.ResponseWriter, r *http.Request) {
	orders.Load(r.Context(), r.PathValue("id"))
	resp, err := http.Get("https://api.example.com/status")
	if err == nil {
		resp.Body.Close()
	}
}
