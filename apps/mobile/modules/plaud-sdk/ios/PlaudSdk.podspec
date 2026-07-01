require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PlaudSdk'
  s.version        = package['version']
  s.summary        = 'Expo native module wrapping the Plaud device SDK (manual path).'
  s.license        = 'UNLICENSED'
  s.author         = 'plaudern'
  s.homepage       = 'https://plaud.ai'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The Plaud XCFrameworks are vendored by the config plugin at prebuild.
  # Once present under ios/Frameworks, expose them here, e.g.:
  # s.vendored_frameworks = 'Frameworks/PlaudBleSDK.xcframework',
  #                         'Frameworks/PlaudDeviceBasicSDK.xcframework',
  #                         'Frameworks/PlaudWiFiSDK.xcframework'

  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,swift}'
end
