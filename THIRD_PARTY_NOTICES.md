# Third-party notices

SCP-Fast starts the installed Windows scp executable directly with Node.js
child_process. It does not bundle node-pty or ConPTY binaries.

SCP-Fast calls the user's installed OpenSSH programs and does not redistribute
OpenSSH. Build and smoke-test dependencies are not included in the VSIX.
