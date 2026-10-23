package com.shop.orders;

import java.util.List;

public record Order(String id, List<Item> items) {}
