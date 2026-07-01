import ExpoModulesCore

// Native bridge to the Plaud device SDK (manual path). The XCFrameworks
// (PlaudBleSDK, PlaudDeviceBasicSDK, PlaudWiFiSDK) are linked by the config
// plugin at prebuild; import them here once available:
//
//   import PlaudBleSDK
//   import PlaudDeviceBasicSDK
//   import PlaudWiFiSDK
//
// The callback-based SDK API is bridged to Promises below. The bodies are
// scaffolded: wire each to the corresponding SDK call once the frameworks and
// Plaud dev-console credentials are in place (plan §4/§7).

public class PlaudSdkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PlaudSdk")

    Events("onScanResult", "onTransferProgress")

    AsyncFunction("initialize") { (clientId: String, clientSecret: String, promise: Promise) in
      // PlaudSDK.shared.configure(clientId: clientId, secret: clientSecret) { result in ... }
      promise.resolve(nil)
    }

    AsyncFunction("scanDevices") { (timeoutMs: Int, promise: Promise) in
      // PlaudBle.scan(timeout: timeoutMs) { devices in promise.resolve(devices.map(serialize)) }
      promise.resolve([Any]())
    }

    AsyncFunction("connect") { (deviceId: String, transport: String, promise: Promise) in
      // transport == "wifi" ? PlaudWiFi.connect(deviceId) : PlaudBle.connect(deviceId)
      promise.resolve(nil)
    }

    AsyncFunction("listRecordings") { (promise: Promise) in
      // PlaudDevice.fileList { files in promise.resolve(files.map(serialize)) }
      promise.resolve([Any]())
    }

    AsyncFunction("exportRecording") { (recordingId: String, format: String, promise: Promise) in
      // PlaudDevice.export(recordingId, format: format) { localUrl, size in
      //   promise.resolve(["fileUri": localUrl, "contentType": mime(format), "byteSize": size])
      // }
      promise.reject("E_NOT_IMPLEMENTED", "Link the Plaud XCFrameworks to enable export")
    }

    AsyncFunction("disconnect") { (promise: Promise) in
      promise.resolve(nil)
    }
  }
}
