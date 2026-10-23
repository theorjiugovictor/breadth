package com.shop.orders;

import com.shop.orders.repo.OrderRepository;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.*;

/** HTTP API for orders. */
@RestController
@RequestMapping("/api")
public class OrderController {
    private static final String TOPIC = "order-created";
    private final OrderRepository repo;
    private final KafkaTemplate<String, String> kafka;
    private final PriceService prices;

    public OrderController(OrderRepository repo, KafkaTemplate<String, String> kafka, PriceService prices) {
        this.repo = repo;
        this.kafka = kafka;
        this.prices = prices;
    }

    @PostMapping("/orders")
    public Order create(@RequestBody Order order) {
        for (Item item : order.items()) {
            prices.priceOf(item);
        }
        Order saved = repo.save(order);
        kafka.send(TOPIC, saved.id());
        return saved;
    }

    @GetMapping(value = "/orders/{id}")
    public Order get(@PathVariable String id) {
        return repo.findById(id).orElseThrow();
    }

    @RequestMapping(value = "/orders/{id}", method = RequestMethod.DELETE)
    public void delete(@PathVariable String id) {
        audit(id);
        repo.deleteById(id);
    }

    private void audit(String id) {
        System.out.println(id);
    }
}
