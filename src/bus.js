// tiny event bus so the phaser scene and the HTML HUD never import each other
class Bus {
  constructor() {
    this.handlers = new Map();
  }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn); // call this to unsubscribe
  }
  emit(event, payload) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(payload);
  }
}

export const bus = new Bus();
