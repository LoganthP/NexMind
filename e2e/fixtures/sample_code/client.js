export function fetchOrders(apiUrl) {
  return fetch(`${apiUrl}/orders`).then(res => res.json());
}
export function renderOrders(orders) {
  return orders.map(o => `Order #${o.id}`).join(", ");
}
