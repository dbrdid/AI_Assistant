Pod::Spec.new do |s|
  s.name           = 'DeviceFileAccess'
  s.version        = '0.1.0'
  s.summary        = 'Reference files selected by the user without copying their contents'
  s.description    = s.summary
  s.author         = 'Planner team'
  s.homepage       = 'https://github.com/dbrdid/AI_Assistant'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift}"
end
