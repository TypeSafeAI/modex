// Windows CLI and terminal ownership: assign the suspended child before any user code runs.
// The unnamed, non-inheritable job handle kills its descendants even if this
// supervisor is terminated. Parent death is observed through a retained handle.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <cerrno>
#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

class Handle {
public:
  HANDLE value;
  explicit Handle(HANDLE handle = nullptr) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

[[noreturn]] static void fail(const char* operation) {
  throw std::runtime_error(std::string(operation) + " failed (Windows " + std::to_string(GetLastError()) + ").");
}

static std::wstring quote(const wchar_t* input) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (const wchar_t* p = input; ; ++p) {
    if (*p == L'\\') { ++slashes; continue; }
    if (*p == L'"' || *p == L'\0') {
      out.append(slashes * 2 + (*p == L'"' ? 1 : 0), L'\\');
    } else out.append(slashes, L'\\');
    slashes = 0;
    if (*p == L'\0') break;
    out += *p;
  }
  out += L'"';
  return out;
}

static HANDLE parentHandle(DWORD expected) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) fail("Parent snapshot");
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool matches = false;
  if (!Process32FirstW(snapshot.value, &entry)) fail("Parent lookup");
  do {
    if (entry.th32ProcessID == GetCurrentProcessId()) {
      matches = entry.th32ParentProcessID == expected;
      break;
    }
  } while (Process32NextW(snapshot.value, &entry));
  if (!matches) throw std::runtime_error("CLI supervisor parent does not match.");
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, expected);
  if (!parent) fail("Open parent");
  FILETIME born{}, own{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(parent, &born, &exit, &kernel, &user) ||
      !GetProcessTimes(GetCurrentProcess(), &own, &exit, &kernel, &user) ||
      CompareFileTime(&born, &own) > 0 || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) {
    CloseHandle(parent);
    throw std::runtime_error("CLI supervisor parent exited or changed identity.");
  }
  return parent;
}

static HANDLE childStream(DWORD identifier, bool input) {
  HANDLE source = GetStdHandle(identifier);
  if (!source || source == INVALID_HANDLE_VALUE) {
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    source = CreateFileW(L"NUL", input ? GENERIC_READ : GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    if (source == INVALID_HANDLE_VALUE) fail("Open null stream");
    return source;
  }
  HANDLE duplicate = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) fail("Duplicate CLI stream");
  return duplicate;
}

// A custom handler protects only this supervisor. Unlike a NULL ignore handler,
// it does not disable Ctrl-C in the interactive shell or its children.
static BOOL WINAPI terminalControl(DWORD signal) {
  return signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT;
}

static HANDLE terminalPipe(const wchar_t* name, DWORD parent, HANDLE parentProcess) {
  if (std::wstring(name).rfind(LR"(\\.\pipe\modex-terminal-)", 0) != 0)
    throw std::runtime_error("Invalid terminal control pipe.");
  const ULONGLONG deadline = GetTickCount64() + 5000;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (;;) {
    pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) break;
    const DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PIPE_BUSY) fail("Connect terminal control");
    if (GetTickCount64() >= deadline || WaitForSingleObject(parentProcess, 20) != WAIT_TIMEOUT)
      throw std::runtime_error("Terminal control did not become available.");
  }
  ULONG server = 0;
  if (!GetNamedPipeServerProcessId(pipe, &server) || server != parent) {
    CloseHandle(pipe);
    throw std::runtime_error("Terminal control does not belong to Modex.");
  }
  return pipe;
}

static bool terminalClosing(HANDLE pipe, std::string& command) {
  DWORD available = 0;
  if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
    if (GetLastError() == ERROR_BROKEN_PIPE) return true;
    fail("Read terminal control");
  }
  if (!available) return false;
  char buffer[6];
  DWORD read = 0;
  // Only this thread reads; never issue a blocking read for unavailable bytes.
  const DWORD count = available < sizeof(buffer) ? available : static_cast<DWORD>(sizeof(buffer));
  if (!ReadFile(pipe, buffer, count, &read, nullptr)) {
    if (GetLastError() == ERROR_BROKEN_PIPE) return true;
    fail("Read terminal close");
  }
  command.append(buffer, read);
  if (command.size() > 6 || std::string("CLOSE\n").compare(0, command.size(), command) != 0)
    throw std::runtime_error("Invalid terminal control command.");
  return command == "CLOSE\n";
}

int wmain(int argc, wchar_t** argv) {
  try {
    const bool terminal = argc > 1 && wcscmp(argv[1], L"--terminal") == 0;
    const int parentIndex = terminal ? 2 : 1;
    const int executableIndex = terminal ? 4 : 2;
    if (argc <= executableIndex) throw std::runtime_error("Missing supervisor arguments.");
    wchar_t* end = nullptr;
    errno = 0;
    const unsigned long pid = wcstoul(argv[parentIndex], &end, 10);
    if (errno || !pid || !end || *end) throw std::runtime_error("Invalid parent PID.");
    Handle parent(parentHandle(static_cast<DWORD>(pid)));
    Handle control(terminal ? terminalPipe(argv[3], static_cast<DWORD>(pid), parent.value) : nullptr);
    if (terminal && (!SetConsoleCtrlHandler(nullptr, FALSE) || !SetConsoleCtrlHandler(terminalControl, TRUE)))
      fail("Protect terminal supervisor");
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.value) fail("Create CLI job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail("Configure CLI job");

    std::wstring command;
    for (int i = executableIndex; i < argc; ++i) { if (i > executableIndex) command += L' '; command += quote(argv[i]); }
    if (command.size() >= 32767) throw std::runtime_error("CLI command line exceeds the Windows limit.");
    Handle input(terminal ? nullptr : childStream(STD_INPUT_HANDLE, true));
    Handle output(terminal ? nullptr : childStream(STD_OUTPUT_HANDLE, false));
    Handle error(terminal ? nullptr : childStream(STD_ERROR_HANDLE, false));
    HANDLE streams[] = {input.value, output.value, error.value};
    SIZE_T size = 0;
    const DWORD attributeCount = terminal ? 1 : 2;
    InitializeProcThreadAttributeList(nullptr, attributeCount, 0, &size);
    std::vector<unsigned char> storage(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(attributes, attributeCount, 0, &size)) fail("Initialize CLI attributes");
    struct AttributeCleanup { LPPROC_THREAD_ATTRIBUTE_LIST list; ~AttributeCleanup() { DeleteProcThreadAttributeList(list); } } cleanup{attributes};
    if (!terminal && !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams, sizeof(streams), nullptr, nullptr)) fail("Restrict CLI handles");
    HANDLE jobs[] = {job.value};
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), nullptr, nullptr)) fail("Assign CLI ownership");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = terminal ? 0 : STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.value;
    startup.StartupInfo.hStdOutput = output.value;
    startup.StartupInfo.hStdError = error.value;
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(terminal ? nullptr : argv[executableIndex], command.data(), nullptr, nullptr, terminal ? FALSE : TRUE,
        CREATE_SUSPENDED | (terminal ? 0 : CREATE_NO_WINDOW) | EXTENDED_STARTUPINFO_PRESENT,
        nullptr, nullptr, &startup.StartupInfo, &process)) fail("Start CLI");
    Handle child(process.hProcess);
    Handle thread(process.hThread);
    if (WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT) throw std::runtime_error("Modex exited before CLI startup.");
    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) fail("Resume CLI");
    HANDLE waits[] = {child.value, parent.value};
    DWORD code = 1;
    std::string closeCommand;
    for (;;) {
      const DWORD result = WaitForMultipleObjects(2, waits, FALSE, terminal ? 25 : INFINITE);
      if (result == WAIT_OBJECT_0) {
        if (!GetExitCodeProcess(child.value, &code)) fail("Read CLI exit");
        break;
      }
      if (result == WAIT_OBJECT_0 + 1) break;
      if (result != WAIT_TIMEOUT) fail("Wait for CLI");
      if (terminalClosing(control.value, closeCommand)) break;
    }
    if (!TerminateJobObject(job.value, code)) fail("Stop CLI descendants");
    const ULONGLONG deadline = GetTickCount64() + 5000;
    for (;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) fail("Check CLI descendants");
      if (accounting.ActiveProcesses == 0) break;
      if (GetTickCount64() >= deadline) throw std::runtime_error("CLI descendants did not confirm shutdown.");
      Sleep(10);
    }
    if (terminal) {
      DWORD written = 0;
      if (!WriteFile(control.value, "CLEAN\n", 6, &written, nullptr) || written != 6)
        fail("Confirm terminal cleanup");
    }
    return static_cast<int>(code);
  } catch (const std::exception& error) {
    std::cerr << "Modex CLI supervisor: " << error.what() << '\n';
    return 127;
  }
}
