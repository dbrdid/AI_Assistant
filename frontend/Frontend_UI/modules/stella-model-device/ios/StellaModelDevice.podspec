Pod::Spec.new do |s|
  s.name = 'StellaModelDevice'
  s.version = '1.0.0'
  s.summary = 'On-device model storage and memory checks'
  s.author = 'Stella team'
  s.homepage = 'https://github.com/dbrdid/AI_Assistant'
  s.license = { :type => 'UNLICENSED' }
  s.platforms = { :ios => '15.1' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
