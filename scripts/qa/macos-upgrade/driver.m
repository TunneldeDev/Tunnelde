#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <libproc.h>
#include <limits.h>
#include <pwd.h>
#include <unistd.h>

static int emit(NSDictionary *result) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:NULL];
  if (!json) return 1;
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  return 0;
}

static NSDictionary *capabilities(void) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  uid_t uid = (uid_t)-1;
  gid_t gid = (gid_t)-1;
  NSString *console = CFBridgingRelease(SCDynamicStoreCopyConsoleUser(NULL, &uid, &gid));
  return @{
    @"consoleUserMatches": ([console isEqualToString:@"runner"] && uid == getuid()) ? @YES : @NO,
    @"onConsole": [session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] ? @YES : @NO,
    @"loginDone": [session[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue] ? @YES : @NO,
    @"screenCount": @(NSScreen.screens.count),
    @"accessibilityTrusted": AXIsProcessTrusted() ? @YES : @NO,
    @"screenCaptureAllowed": CGPreflightScreenCaptureAccess() ? @YES : @NO,
    @"schemaVersion": @1,
  };
}

static id attribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, key, &value) != kAXErrorSuccess) return nil;
  return CFBridgingRelease(value);
}

static NSDictionary *identity(pid_t pid, NSString *expected) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  struct proc_bsdinfo info = {0};
  if (proc_pidpath(pid, path, sizeof(path)) <= 0 ||
      ![[NSString stringWithUTF8String:path] isEqualToString:expected] ||
      proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_uid != getuid()) return nil;
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (![app.bundleIdentifier isEqualToString:@"dev.tunnelde.app"]) return nil;
  return @{@"pid": @(pid), @"startSeconds": @(info.pbi_start_tvsec),
           @"startMicroseconds": @(info.pbi_start_tvusec), @"executable": expected,
           @"identifier": app.bundleIdentifier};
}

static void walk(AXUIElementRef element, NSUInteger depth, NSMutableArray *nodes,
                 NSMutableArray *matches, NSString *label, CFAbsoluteTime deadline) {
  if (depth > 24 || nodes.count >= 1000 || CFAbsoluteTimeGetCurrent() > deadline) return;
  id role = attribute(element, kAXRoleAttribute);
  NSMutableDictionary *node = [NSMutableDictionary dictionaryWithDictionary:@{@"depth": @(depth)}];
  if ([role isKindOfClass:NSString.class]) node[@"role"] = role;
  NSArray *keys = @[(__bridge NSString *)kAXTitleAttribute, (__bridge NSString *)kAXDescriptionAttribute,
                    (__bridge NSString *)kAXIdentifierAttribute, (__bridge NSString *)kAXEnabledAttribute];
  for (NSString *key in keys) {
    id value = attribute(element, (__bridge CFStringRef)key);
    if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) node[key] = value;
  }
  // Never inspect a secure input's value. This harness seeds synthetic data only.
  if (![role isEqualToString:@"AXSecureTextField"]) {
    id value = attribute(element, kAXValueAttribute);
    if ([value isKindOfClass:NSString.class]) node[@"AXValue"] = value;
  }
  [nodes addObject:node];
  if (label && ([node[@"AXTitle"] isEqual:label] || [node[@"AXDescription"] isEqual:label] ||
                [node[@"AXValue"] isEqual:label]) &&
      ![node[@"AXEnabled"] isEqual:@NO] &&
      ([role isEqualToString:@"AXButton"] || [role isEqualToString:@"AXMenuItem"])) {
    [matches addObject:(__bridge id)element];
  }
  id children = attribute(element, kAXChildrenAttribute);
  if ([children isKindOfClass:NSArray.class]) {
    for (id child in children) {
      if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID())
        walk((__bridge AXUIElementRef)child, depth + 1, nodes, matches, label, deadline);
    }
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    NSString *home = [@"/Users" stringByAppendingPathComponent:@"runner"];
    struct passwd *user = getpwuid(getuid());
    NSString *ref = env[@"GITHUB_REF"];
    NSString *workflow = [@"TunneldeDev/Tunnelde/.github/workflows/macos-public-ota.yml@" stringByAppendingString:ref ?: @""];
    if (!user || getuid() == 0 || strcmp(user->pw_name, "runner") != 0 ||
        strcmp(user->pw_dir, home.fileSystemRepresentation) != 0 ||
        ![env[@"HOME"] isEqual:home] || ![env[@"GITHUB_ACTIONS"] isEqual:@"true"] ||
        ![env[@"RUNNER_ENVIRONMENT"] isEqual:@"github-hosted"] ||
        ![env[@"GITHUB_REPOSITORY"] isEqual:@"TunneldeDev/Tunnelde"] ||
        ![env[@"GITHUB_EVENT_NAME"] isEqual:@"workflow_dispatch"] ||
        ![env[@"GITHUB_WORKFLOW_REF"] isEqual:workflow] ||
        ![env[@"MACOS_OTA_ACK"] isEqual:@"original-public-ota"] || argc < 2) {
      fputs("Refusing a non-hosted original-package driver\n", stderr);
      return 2;
    }
    NSString *action = [NSString stringWithUTF8String:argv[1]];
    if ([action isEqual:@"capabilities"]) return emit(capabilities());
    if ([action isEqual:@"profile"]) {
      LAContext *authentication = [LAContext new];
      authentication.interactionNotAllowed = YES;
      NSDictionary *query = @{(__bridge NSString *)kSecClass: (__bridge id)kSecClassGenericPassword,
                              (__bridge NSString *)kSecAttrService: @"dev.tunnelde.app",
                              (__bridge NSString *)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
                              (__bridge NSString *)kSecUseAuthenticationContext: authentication};
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, NULL);
      return emit(@{@"keychainStatus": @(status), @"serviceAbsent": status == errSecItemNotFound ? @YES : @NO,
                    @"existingApps": @([NSRunningApplication runningApplicationsWithBundleIdentifier:@"dev.tunnelde.app"].count)});
    }
    if (argc < 3) return 2;
    char *end = NULL;
    long number = strtol(argv[2], &end, 10);
    if (!end || *end || number <= 1 || number > INT_MAX) return 2;
    pid_t pid = (pid_t)number;
    NSString *root = [env[@"RUNNER_TEMP"] stringByAppendingPathComponent:
        [NSString stringWithFormat:@"tunnelde-macos-public-ota-%@-%@", env[@"GITHUB_RUN_ID"], env[@"GITHUB_RUN_ATTEMPT"]]];
    NSString *executable = [root stringByAppendingPathComponent:@"install/Tunnelde.app/Contents/MacOS/tunnelde"];
    NSDictionary *process = identity(pid, executable);
    if (!process) { fputs("Target identity did not match this owned bundle\n", stderr); return 3; }
    if ([action isEqual:@"identity"]) return emit(process);
    if ([action isEqual:@"activate"]) {
      NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
      BOOL activated = [app activateWithOptions:NSApplicationActivateAllWindows];
      return emit(@{@"identity": process, @"activated": activated ? @YES : @NO});
    }
    if (!AXIsProcessTrusted()) return 4;
    if ([action isEqual:@"key"] && argc == 4) {
      NSString *key = [NSString stringWithUTF8String:argv[3]];
      CGKeyCode code;
      CGEventFlags flags = kCGEventFlagMaskCommand;
      if ([key isEqual:@"quit"]) code = 12;
      else if ([key isEqual:@"settings"]) code = 43; // Cmd+Comma, the product Settings command.
      else return 2;
      for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down != 0);
        if (!event) return 5;
        CGEventSetFlags(event, flags);
        CGEventPostToPid(pid, event);
        CFRelease(event);
      }
      return emit(@{@"identity": process, @"key": key, @"generatedOSInput": @YES});
    }
    if (![action isEqual:@"tree"] && ![action isEqual:@"press"]) return 2;
    NSString *label = argc == 4 ? [NSString stringWithUTF8String:argv[3]] : nil;
    if ([action isEqual:@"press"] && !label) return 2;
    AXUIElementRef target = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(target, 1.0);
    NSMutableArray *nodes = [NSMutableArray array], *matches = [NSMutableArray array];
    walk(target, 0, nodes, matches, label, CFAbsoluteTimeGetCurrent() + 12);
    AXError status = kAXErrorSuccess;
    if ([action isEqual:@"press"]) {
      status = matches.count == 1 ? AXUIElementPerformAction((__bridge AXUIElementRef)matches[0], kAXPressAction) : kAXErrorIllegalArgument;
    }
    CFRelease(target);
    int result = emit(@{@"identity": process, @"nodes": nodes, @"matches": @(matches.count), @"axStatus": @(status)});
    return status == kAXErrorSuccess ? result : 6;
  }
}
