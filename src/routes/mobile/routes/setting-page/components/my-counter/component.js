module.exports = class {
  onCreate() {
    this.state = {
      count: 0
    };
  }

  increment() {
    this.state.count++;
  }

  decrement() {
    this.state.count--;
  }
};
