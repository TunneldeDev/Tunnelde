#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <CommonCrypto/CommonDigest.h>
#include <libproc.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
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
    @"osVersion": NSProcessInfo.processInfo.operatingSystemVersionString,
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

static BOOL walk(AXUIElementRef element, NSUInteger depth, NSMutableArray *nodes,
                 NSMutableArray *matches, NSString *label, NSString *selection, CFAbsoluteTime deadline) {
  if (depth > 24 || nodes.count >= 1000 || CFAbsoluteTimeGetCurrent() > deadline) return NO;
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
  id subrole = attribute(element, kAXSubroleAttribute);
  if (![role isEqualToString:@"AXSecureTextField"] && ![subrole isEqualToString:@"AXSecureTextField"]) {
    id value = attribute(element, kAXValueAttribute);
    if ([value isKindOfClass:NSString.class]) node[@"AXValue"] = value;
  }
  [nodes addObject:node];
  BOOL labelMatches = [node[@"AXTitle"] isEqual:label] || [node[@"AXDescription"] isEqual:label];
  if ([selection isEqual:@"title-only"]) labelMatches = [node[@"AXTitle"] isEqual:label] && [node[@"AXDescription"] isEqual:@""];
  if ([selection isEqual:@"described"]) labelMatches = [node[@"AXDescription"] isEqual:label];
  if ([selection isEqual:@"prefix"] || [selection isEqual:@"tab-prefix"])
    labelMatches = [node[@"AXTitle"] isKindOfClass:NSString.class] && [node[@"AXTitle"] hasPrefix:label];
  BOOL roleMatches = [selection isEqual:@"fill"]
      ? ([role isEqualToString:@"AXTextField"] || [role isEqualToString:@"AXTextArea"] || [role isEqualToString:@"AXSecureTextField"])
      : [selection isEqual:@"tab-prefix"] ? ([role isEqualToString:@"AXRadioButton"] || [role isEqualToString:@"AXTab"])
      : ([role isEqualToString:@"AXButton"] || [role isEqualToString:@"AXMenuItem"]);
  if (label && labelMatches && [node[@"AXEnabled"] isEqual:@YES] && roleMatches) {
    [matches addObject:(__bridge id)element];
  }
  id children = attribute(element, kAXChildrenAttribute);
  if ([children isKindOfClass:NSArray.class]) {
    for (id child in children) {
      if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID() &&
          !walk((__bridge AXUIElementRef)child, depth + 1, nodes, matches, label, selection, deadline)) return NO;
    }
  }
  return YES;
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
    NSString *root = [env[@"RUNNER_TEMP"] stringByAppendingPathComponent:
        [NSString stringWithFormat:@"tunnelde-macos-public-ota-%@-%@", env[@"GITHUB_RUN_ID"], env[@"GITHUB_RUN_ATTEMPT"]]];
    NSString *executable = [root stringByAppendingPathComponent:@"install/Tunnelde.app/Contents/MacOS/tunnelde"];
    if ([action isEqual:@"locate"]) {
      NSMutableArray *owned = [NSMutableArray array];
      for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"dev.tunnelde.app"]) {
        NSDictionary *value = identity(app.processIdentifier, executable);
        if (value) [owned addObject:value];
      }
      return emit(@{@"processes": owned});
    }
    if (([action isEqual:@"credential"] || [action isEqual:@"credential-item"]) && argc == 3) {
      NSString *identifier = [NSString stringWithUTF8String:argv[2]];
      NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:identifier];
      if (!uuid || ![uuid.UUIDString.lowercaseString isEqual:identifier]) return 2;
      NSString *account = [action isEqual:@"credential-item"]
          ? [@"tunnelde.credential.v1:" stringByAppendingString:identifier] : identifier;
      LAContext *authentication = [LAContext new];
      authentication.interactionNotAllowed = YES;
      NSDictionary *query = @{(__bridge NSString *)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge NSString *)kSecAttrService: @"dev.tunnelde.app", (__bridge NSString *)kSecAttrAccount: account,
        (__bridge NSString *)kSecReturnPersistentRef: @YES, (__bridge NSString *)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
        (__bridge NSString *)kSecUseAuthenticationContext: authentication};
      CFTypeRef result = NULL;
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
      NSData *reference = CFBridgingRelease(result);
      NSMutableDictionary *value = [NSMutableDictionary dictionaryWithDictionary:@{@"status": @(status), @"account": account, @"secretRead": @NO}];
      if (status == errSecSuccess && [reference isKindOfClass:NSData.class]) {
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(reference.bytes, (CC_LONG)reference.length, digest);
        NSMutableString *hash = [NSMutableString string];
        for (NSUInteger i = 0; i < sizeof(digest); i++) [hash appendFormat:@"%02x", digest[i]];
        value[@"persistentReferenceSha256"] = hash;
      }
      return emit(value);
    }
    if (argc < 3) return 2;
    char *end = NULL;
    long number = strtol(argv[2], &end, 10);
    if (!end || *end || number <= 1 || number > INT_MAX) return 2;
    pid_t pid = (pid_t)number;
    NSDictionary *process = identity(pid, executable);
    if (!process) { fputs("Target identity did not match this owned bundle\n", stderr); return 3; }
    if ([action isEqual:@"identity"]) return emit(process);
    if ([action isEqual:@"stop"] && argc == 6) {
      if (![[NSString stringWithUTF8String:argv[3]] isEqual:[process[@"startSeconds"] stringValue]] ||
          ![[NSString stringWithUTF8String:argv[4]] isEqual:[process[@"startMicroseconds"] stringValue]]) return 3;
      NSString *signalName = [NSString stringWithUTF8String:argv[5]];
      int signalNumber = [signalName isEqual:@"TERM"] ? SIGTERM : [signalName isEqual:@"KILL"] ? SIGKILL : 0;
      if (!signalNumber) return 2;
      int result = kill(pid, signalNumber);
      return emit(@{@"identity": process, @"signal": signalName, @"result": @(result)});
    }
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
      else if ([key isEqual:@"new-host"]) code = 45;
      else if ([key isEqual:@"go-to-folder"]) { code = 5; flags |= kCGEventFlagMaskShift; }
      else if ([key isEqual:@"enter"]) { code = 36; flags = 0; }
      else return 2;
      BOOL nativeDialogKey = [key isEqual:@"go-to-folder"] || [key isEqual:@"enter"];
      if (nativeDialogKey &&
          (![env[@"MACOS_OTA_MODE"] isEqual:@"retention"] ||
           NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)) return 3;
      if (nativeDialogKey) {
        AXUIElementRef target = AXUIElementCreateApplication(pid);
        AXUIElementSetMessagingTimeout(target, 1.0);
        NSMutableArray *nodes = [NSMutableArray array], *matches = [NSMutableArray array];
        BOOL complete = walk(target, 0, nodes, matches, nil, nil, CFAbsoluteTimeGetCurrent() + 12);
        BOOL picker = NO;
        for (NSDictionary *node in nodes) {
          if ([node[@"role"] isEqual:@"AXStaticText"] && [node[@"AXValue"] isEqual:@"Plugin folder"]) picker = YES;
        }
        CFRelease(target);
        if (!complete || !picker) return 3;
      }
      for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down != 0);
        if (!event) return 5;
        CGEventSetFlags(event, flags);
        if (nativeDialogKey) CGEventPost(kCGSessionEventTap, event);
        else CGEventPostToPid(pid, event);
        CFRelease(event);
      }
      return emit(@{@"identity": process, @"key": key, @"generatedOSInput": @YES});
    }
    if ([action isEqual:@"plugin-path"] && argc == 3) {
      if (![env[@"MACOS_OTA_MODE"] isEqual:@"retention"]) return 2;
      NSString *path = [root stringByAppendingPathComponent:@"retention-plugin"];
      char resolved[PATH_MAX];
      BOOL directory = NO;
      if (!realpath(path.fileSystemRepresentation, resolved) ||
          ![path isEqual:[NSString stringWithUTF8String:resolved]] ||
          ![NSFileManager.defaultManager fileExistsAtPath:path isDirectory:&directory] || !directory) return 3;
      AXUIElementRef target = AXUIElementCreateApplication(pid);
      AXUIElementSetMessagingTimeout(target, 1.0);
      id focused = attribute(target, kAXFocusedUIElementAttribute);
      BOOL ready = focused && CFGetTypeID((__bridge CFTypeRef)focused) == AXUIElementGetTypeID() &&
          ([@[@"AXComboBox", @"AXTextField"] containsObject:attribute((__bridge AXUIElementRef)focused, kAXRoleAttribute)]);
      CFRelease(target);
      if (!ready) return emit(@{@"pathEntered": @NO});
      if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) return 3;
      UniChar buffer[PATH_MAX];
      if (!path.length || path.length >= PATH_MAX) return 3;
      [path getCharacters:buffer range:NSMakeRange(0, path.length)];
      for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down != 0);
        if (!event) return 5;
        CGEventSetFlags(event, kCGEventFlagMaskCommand);
        CGEventPost(kCGSessionEventTap, event); CFRelease(event);
      }
      usleep(100000);
      for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down != 0);
        if (!event) return 5;
        CGEventSetFlags(event, 0);
        CGEventKeyboardSetUnicodeString(event, path.length, buffer);
        CGEventPost(kCGSessionEventTap, event); CFRelease(event);
      }
      return emit(@{@"identity": process, @"pathEntered": @YES, @"generatedOSInput": @YES});
    }
    BOOL fill = [action isEqual:@"fill"];
    if (![action isEqual:@"tree"] && ![action isEqual:@"press"] && !fill) return 2;
    NSString *label = argc >= 4 ? [NSString stringWithUTF8String:argv[3]] : nil;
    NSString *selection = fill ? @"fill" : argc == 5 ? [NSString stringWithUTF8String:argv[4]] : @"button";
    if (([action isEqual:@"press"] || fill) && !label) return 2;
    AXUIElementRef target = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(target, 1.0);
    NSMutableArray *nodes = [NSMutableArray array], *matches = [NSMutableArray array];
    BOOL complete = walk(target, 0, nodes, matches, label, selection, CFAbsoluteTimeGetCurrent() + 12);
    AXError status = kAXErrorSuccess;
    if ([action isEqual:@"press"]) {
      status = complete && matches.count == 1 ? AXUIElementPerformAction((__bridge AXUIElementRef)matches[0], kAXPressAction) : kAXErrorIllegalArgument;
    }
    if (fill) {
      NSString *text = env[@"MACOS_OTA_TEXT"];
      status = complete && matches.count == 1 && text.length > 0 && text.length <= 1024
          ? AXUIElementSetAttributeValue((__bridge AXUIElementRef)matches[0], kAXFocusedAttribute, kCFBooleanTrue)
          : kAXErrorIllegalArgument;
      if (status == kAXErrorSuccess) {
        for (int down = 1; down >= 0; down--) {
          CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down != 0); // Cmd+A
          if (!event) { status = kAXErrorFailure; break; }
          CGEventSetFlags(event, kCGEventFlagMaskCommand);
          CGEventPostToPid(pid, event); CFRelease(event);
        }
        usleep(100000);
        UniChar buffer[1024]; [text getCharacters:buffer range:NSMakeRange(0, text.length)];
        for (int down = 1; status == kAXErrorSuccess && down >= 0; down--) {
          CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down != 0);
          if (!event) { status = kAXErrorFailure; break; }
          CGEventSetFlags(event, 0);
          CGEventKeyboardSetUnicodeString(event, text.length, buffer);
          CGEventPostToPid(pid, event); CFRelease(event);
        }
      }
      // Avoid logging field values, including the synthetic credential.
      [nodes removeAllObjects];
    }
    CFRelease(target);
    int result = emit(@{@"identity": process, @"nodes": nodes, @"matches": @(matches.count), @"axStatus": @(status), @"traversalCompleted": complete ? @YES : @NO});
    return status == kAXErrorSuccess ? result : 6;
  }
}
