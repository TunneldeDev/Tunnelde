#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <pwd.h>
#include <unistd.h>

static NSDictionary *capabilities(int consoleUserMatches, int onConsole,
                                  int loginDone, NSUInteger screenCount,
                                  int accessibilityTrusted, int screenCaptureAllowed) {
  // C comparisons and AX's Boolean can box as numeric 0/1. The wire schema
  // requires JSON booleans on both Intel and Apple Silicon.
  return @{
    @"schemaVersion": @1,
    @"consoleUserMatches": consoleUserMatches ? @YES : @NO,
    @"onConsole": onConsole ? @YES : @NO,
    @"loginDone": loginDone ? @YES : @NO,
    @"screenCount": @(screenCount),
    @"accessibilityTrusted": accessibilityTrusted ? @YES : @NO,
    @"screenCaptureAllowed": screenCaptureAllowed ? @YES : @NO,
  };
}

static int emit(NSDictionary *result) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:result
                                               options:NSJSONWritingPrettyPrinted
                                                 error:NULL];
  if (!json) {
    fputs("Native probe could not encode its capability report\n", stderr);
    return 1;
  }
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // Serialization regression only: this path never queries GUI or TCC APIs.
    if (argc == 2 && strcmp(argv[1], "--format-test") == 0) {
      return emit(capabilities(1, 1, 1, 1, 1, 1));
    }
    if (argc != 1) return 2;
    NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
    NSString *runnerHome = [@"/Users" stringByAppendingPathComponent:@"runner"];
    struct passwd *user = getpwuid(getuid());
    if (!user || getuid() == 0 || strcmp(user->pw_name, "runner") != 0 ||
        strcmp(user->pw_dir, runnerHome.fileSystemRepresentation) != 0 ||
        ![env[@"HOME"] isEqualToString:runnerHome] ||
        ![env[@"GITHUB_ACTIONS"] isEqualToString:@"true"] ||
        ![env[@"RUNNER_ENVIRONMENT"] isEqualToString:@"github-hosted"] ||
        ![env[@"GITHUB_REPOSITORY"] isEqualToString:@"TunneldeDev/Tunnelde"] ||
        ![env[@"GITHUB_EVENT_NAME"] isEqualToString:@"workflow_dispatch"] ||
        ![env[@"MACOS_OTA_ACK"] isEqualToString:@"probe-only"]) {
      fputs("Refusing a non-hosted or unacknowledged GUI probe\n", stderr);
      return 2;
    }
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    uid_t consoleUID = (uid_t)-1;
    gid_t consoleGID = (gid_t)-1;
    NSString *consoleUser = CFBridgingRelease(
        SCDynamicStoreCopyConsoleUser(NULL, &consoleUID, &consoleGID));
    return emit(capabilities(
        [consoleUser isEqualToString:@"runner"] && consoleUID == getuid(),
        [session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue],
        [session[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue],
        NSScreen.screens.count, AXIsProcessTrusted(), CGPreflightScreenCaptureAccess()));
  }
}
