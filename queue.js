export default class Queue {
	constructor(executor) {
		this.executor = executor;
		this.waiting = [];
		this.isRunning = false;
		this.isPaused = false;
	}

	add(item) {
		this.waiting.push(item);
		this.run();
	}

	pause() {
		this.isPaused = true;
	}

	async resume() {
		this.isPaused = false;
		await this.run();
	}

	async run() {
		if (this.isPaused || this.isRunning) return;
		// Nhận các mục chúng tôi sẽ xử lý, danh sách chờ trống và đánh dấu hàng đợi là đang chạy
		var items = [].concat(this.waiting);
		this.waiting = [];
		this.isRunning = true;
		// Thực thi các mục trong danh sách chờ
		await items.reduce(async (promise, item) => {
			await promise;
			try {
				await this.executor(item);
			} catch (err) {
				console.error(err);
			}
		}, Promise.resolve());
		// Đánh dấu hàng đợi là không chạy
		this.isRunning = false;
		// Chạy lại nếu có nhiều mục hơn trong danh sách chờ
		if (this.waiting.length) {
			await this.run();
		}
	}
}
