Pod::Spec.new do |s|
  s.name           = 'StellaAudioSplit'
  s.version        = '0.1.0'
  s.summary        = 'Split a recording into m4a segments without re-encoding'
  s.description    = s.summary
  s.author         = 'Stella team'
  s.homepage       = 'https://github.com/dbrdid/AI_Assistant'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift}"
end
