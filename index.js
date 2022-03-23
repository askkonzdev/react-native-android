import { Platform, AppState, NativeModules, NativeEventEmitter } from "react-native";
import * as RNIap from "react-native-iap";
import { EventRegister } from "react-native-event-listeners";
import fetch from "react-native-fetch-polyfill";
import Queue from "./queue";
import pkg from "./package.json";

// Ngăn cảnh báo "Chu kỳ yêu cầu" được kích hoạt bởi react-native-fetch-polyfill
const RequestObject = Request;
// Thêm chức năng thử lại vào API tìm nạp
const fetchWithRetry = require("fetch-retry")(fetch);

class Inc {
	constructor() {
		this.platform = Platform.OS;
		this.products = [];
		this.productsPricing = null;
		// this.userId = null;
		// this.user = null;
		// this.userFetchDate = null;
		// this.userFetchPromises = [];
		// this.userTagsProcessing = false;
		this.type = "subscriptions";
		this.skuItem = [];
		this.subscriptionsItem = [];
		this.deviceParams = {};
		this.receiptPostDate = null;
		this.isInitialized = false;
		this.canMakePayments = true;
		this.onReceiptProcessed = null;
		this.buyRequest = null;
		this.lastReceiptInfos = null;
		this.receiptQueue = new Queue(this.processReceipt.bind(this));
		this.errorQueue = new Queue(this.processError.bind(this));
	}

	addEventListener(name, listener) {
		return EventRegister.addEventListener(name, listener);
	}
	removeEventListener(listener) {
		return EventRegister.removeEventListener(listener);
	}
	removeAllListeners() {
		return EventRegister.removeAllListeners();
	}
	async init(opts = {}) {
		this.environment = opts.environment || "production";
		this.isInitialized = true;
		this.onReceiptProcessed = opts.onReceiptProcessed;
		this.onBuyRequest = opts.onBuyRequest;
		try {
			var status = await RNIap.initConnection();
			if (this.platform == "ios" && status == "false") this.canMakePayments = false;
		} catch (err) {
			// Check init connection errors
			if (err.message.indexOf("Billing is unavailable") != -1) {
				throw this.error(`The billing is not available`, "billing_unavailable");
			} else {
				throw this.error(`Unknown billing error, did you install react-native-iap properly? (Err: ${err.message})`, "billing_error");
			}
		}
		if (!this.appState) {
			this.appState = AppState.currentState;
			AppState.addEventListener("change", (nextAppState) => {
				if (this.appState != "active" && nextAppState == "active") {
					// this.onForeground();
				} else if (this.appState == "active" && nextAppState != "active") {
					// this.onBackground();
				}
				this.appState = nextAppState;
			});
		}
		if (!this.purchaseUpdatedListener) {
			this.purchaseUpdatedListener = RNIap.purchaseUpdatedListener((purchase) => {
				this.receiptQueue.add({ date: new Date(), purchase: purchase });
				// this.resumeQueues();
			});
		}
		if (!this.purchaseErrorListener) this.purchaseErrorListener = RNIap.purchaseErrorListener((err) => this.errorQueue.add(err));
	}
	async getProductList() {
		try {
			let response = {};
			switch (this.type) {
				case "subscriptions":
					if (!this.subscriptionsItem.length) return { error: 2 };
					response = await RNIap.getSubscriptions(this.subscriptionsItem);
					break;
				case "product":
					if (!this.skuItem.length) return { error: 2 };
					response = await RNIap.getProducts(this.skuItem);
					break;
				default:
					return { error: 3 };
			}
			return response;
		} catch (error) {
			console.log(error);
			return { error: 1 };
		}
	}
	getReceiptToken(purchase) {
		return this.platform == "android" ? purchase.purchaseToken : purchase.transactionReceipt;
	}
	processError(err) {
		var errors = {
			E_UNKNOWN: "unknown", // Lỗi không xác định
			E_SERVICE_ERROR: "billing_unavailable", // Thanh toán không có sẵn
			E_USER_CANCELLED: "user_cancelled", // Cửa sổ bật lên mua hàng do người dùng đóng
			E_ITEM_UNAVAILABLE: "item_unavailable", // Mặt hàng không có sẵn để mua
			E_REMOTE_ERROR: "remote_error", // Lỗi từ xa
			E_NETWORK_ERROR: "network_error", // Lỗi mạng
			E_RECEIPT_FAILED: "receipt_failed", // Biên nhận không thành công
			E_RECEIPT_FINISHED_FAILED: "receipt_finish_failed", // Kết thúc biên nhận không thành công
			E_ALREADY_OWNED: "product_already_owned", // Sản phẩm đã được sở hữu, nó phải được tiêu thụ trước khi được mua lại
			E_DEVELOPER_ERROR: "developer_error", // Lỗi của nhà phát triển, sku sản phẩm có thể không hợp lệ
			E_DEFERRED_PAYMENT: "deferred_payment", // Trả tienef chậm
		};
		var error = this.error(err.message, errors[err.code] || "unknown"); // Lỗi chuyển đổi
		// Từ chối yêu cầu mua nếu hoạt động
		if (this.buyRequest) {
			var request = this.buyRequest;

			this.buyRequest = null;
			// Hỗ trợ thay thế đăng ký trả chậm cho android
			// Sau khi đăng ký hoãn lại android, hãy thay thế trình nghe bằng một danh sách mua hàng trống, điều này gây ra lỗi
			if (this.platform == "android" && request.prorationMode == "deferred" && err.message.indexOf("purchases are null") != -1) {
				var product = this.user.productsForSale.find((product) => product.sku == request.sku);
				request.resolve(product);
			} else {
				// Nếu không thì từ chối yêu cầu
				request.reject(error);
			}
		}
	}

	/*
	 * Hoàn thành biên nhận
	 * @param {Object} purchase Purchase
	 * @param {String} productType Product type
	 */
	async finishReceipt(purchase, productType) {
		var shouldBeConsumed = undefined;

		if (this.platform == "android") {
			// Nếu chúng tôi không tìm thấy loại sản phẩm, chúng tôi không thể kết thúc giao dịch đúng cách
			if (!productType) return;
			// Chúng tôi phải sử dụng các loại 'consumable' và 'subscription' (Đăng ký vì đây là sản phẩm được quản lý trên Android mà người dùng có thể mua lại trong tương lai)
			var shouldBeConsumed = ["consumable", "subscription"].indexOf(productType) != -1 ? true : false;
			// Nếu giao dịch mua đã được biết trước, không cần phải kết thúc giao dịch (nếu không, react-native-iap sẽ báo lỗi)
			if (!shouldBeConsumed && purchase.isAcknowledgedAndroid) return;
		}
		// Kết thúc giao dịch
		try {
			await RNIap.finishTransaction(purchase, shouldBeConsumed);
		} catch (err) {
			// Không quan trọng nếu chúng tôi không thể hoàn thành biên nhận đúng cách tại đây, biên nhận sẽ ở trong hàng đợi và được hoàn thành vào lần tiếp theo khi nó được kích hoạt
			//  cũng đang xác nhận các giao dịch mua trên Android (vì vậy, giao dịch mua sẽ không được hoàn lại sau 3 ngày)
			console.error(err);
		}
	}
	error(message, code, params) {
		var err = new Error(message);

		err.code = code;
		err.params = params;
		return err;
	}
}
