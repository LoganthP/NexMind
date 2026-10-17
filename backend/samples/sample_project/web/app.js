import { formatPrice } from "./util.js";
import axios from "axios";

export class Cart {
  constructor() {
    this.items = [];
  }

  add(item) {
    this.items.push(item);
    return this.render();
  }

  render() {
    return this.items.map((i) => formatPrice(i.price)).join(", ");
  }
}

export async function checkout(cart) {
  const res = await axios.post("/orders", cart.items);
  return res.data;
}
