#import <AppKit/AppKit.h>
#import <Security/Security.h>

// Resolve the shared container through macOS, never by guessing a path outside the sandbox.
static BOOL trustedHost(NSURL *url) {
  NSBundle *bundle = url ? [NSBundle bundleWithURL:url] : nil;
  NSString *identifier = bundle.bundleIdentifier;
  if (!([identifier isEqualToString:@"works.jev.modex.host-preview"] || [identifier isEqualToString:@"ai.typesafe.modex"]) ||
      ![[bundle objectForInfoDictionaryKey:@"ModexDesktopHostProtocol"] isEqual:@1]) return NO;
  SecStaticCodeRef code = NULL;
  SecRequirementRef requirement = NULL;
  NSString *rule = [NSString stringWithFormat:@"anchor apple generic and certificate leaf[subject.OU] = \"9LR8Z8UQ9X\" and identifier \"%@\"", identifier];
  OSStatus result = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
  if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)rule, kSecCSDefaultFlags, &requirement);
  if (result == errSecSuccess) result = SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures, requirement);
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  return result == errSecSuccess;
}

static BOOL supportsDesktopLaunch(NSURL *url) {
  NSBundle *bundle = url ? [NSBundle bundleWithURL:url] : nil;
  // Existing previews start their host service on every ordinary application launch.
  if ([bundle.bundleIdentifier isEqualToString:@"works.jev.modex.host-preview"]) return YES;
  if (![bundle.bundleIdentifier isEqualToString:@"ai.typesafe.modex"] ||
      ![[bundle objectForInfoDictionaryKey:@"ModexDesktopHostLaunchProtocol"] isEqual:@1]) return NO;
  id types = [bundle objectForInfoDictionaryKey:@"CFBundleURLTypes"];
  if (![types isKindOfClass:[NSArray class]]) return NO;
  for (id type in types) {
    if (![type isKindOfClass:[NSDictionary class]]) continue;
    id schemes = type[@"CFBundleURLSchemes"];
    if ([schemes isKindOfClass:[NSArray class]] && [schemes containsObject:@"modex-host"]) return YES;
  }
  return NO;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *action = argc > 1 ? @(argv[1]) : @"directory";
    if ([action isEqualToString:@"directory"]) {
      NSURL *url = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:@"9LR8Z8UQ9X.works.jev.modex.desktop"];
      if (!url) return 1;
      puts(url.fileSystemRepresentation);
      return 0;
    }
    if ([action isEqualToString:@"installed"]) {
      NSMutableArray<NSURL *> *candidates = [NSMutableArray array];
      // An adjacent preview is preferred over an older registered development copy.
      if (argc > 2) [candidates addObject:[NSURL fileURLWithPath:@(argv[2])]];
      for (NSString *identifier in @[@"works.jev.modex.host-preview", @"ai.typesafe.modex"]) {
        // A legacy regular build must not hide a launch-capable copy with the same ID.
        [candidates addObjectsFromArray:[[NSWorkspace sharedWorkspace] URLsForApplicationsWithBundleIdentifier:identifier]];
      }
      for (NSURL *url in candidates) if (trustedHost(url) && supportsDesktopLaunch(url)) { puts(url.fileSystemRepresentation); return 0; }
      return 1;
    }
    if ([action isEqualToString:@"launch"] && argc == 3) {
      NSURL *url = [NSURL fileURLWithPath:@(argv[2])];
      if (!trustedHost(url) || !supportsDesktopLaunch(url)) return 1; // Revalidate immediately before launch.
      NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
      config.activates = YES;
      config.allowsRunningApplicationSubstitution = NO;
      config.createsNewApplicationInstance = NO;
      __block BOOL done = NO;
      __block BOOL success = NO;
      void (^completion)(NSRunningApplication *, NSError *) = ^(NSRunningApplication *application, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{ success = application != nil && error == nil; done = YES; });
      };
      if ([[NSBundle bundleWithURL:url].bundleIdentifier isEqualToString:@"works.jev.modex.host-preview"]) {
        [[NSWorkspace sharedWorkspace] openApplicationAtURL:url configuration:config completionHandler:completion];
      } else {
        // NSWorkspace ignores arguments from sandboxed callers. Deliver a payload-free
        // activation URL to this exact validated app, reusing its existing process.
        [[NSWorkspace sharedWorkspace] openURLs:@[[NSURL URLWithString:@"modex-host://connect"]] withApplicationAtURL:url configuration:config completionHandler:completion];
      }
      NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:12];
      while (!done && [deadline timeIntervalSinceNow] > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
      return success ? 0 : 1;
    }
    return 1;
  }
}
