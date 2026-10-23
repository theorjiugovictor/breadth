package com.shop.orders;

import org.springframework.jdbc.core.JdbcTemplate;

public class PriceService {
    private final JdbcTemplate jdbc;

    public PriceService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public double priceOf(Item item) {
        return jdbc.queryForObject("SELECT price FROM products WHERE sku = ?", Double.class, item.sku());
    }
}
