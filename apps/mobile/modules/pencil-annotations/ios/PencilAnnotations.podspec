Pod::Spec.new do |s|
  s.name           = 'PencilAnnotations'
  s.version        = '1.0.0'
  s.summary        = 'Apple Pencil annotation surface for OpenBot.'
  s.description    = 'A pencil-only marker layer over an AI message, with a squeeze-to-send gesture.'
  s.author         = 'OpenBot'
  s.homepage       = 'https://openbot.run'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
