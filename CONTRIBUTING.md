# Contributing to Eshlik

Thank you for your interest in contributing to Eshlik. This guide explains how to set up the project, report problems, and send changes.

Eshlik is a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais and contributors. Much of the codebase is theirs, so if you find a bug that also exists upstream, consider reporting it to Handy as well.

## Philosophy

We want Eshlik to be a useful dictation tool and a codebase that stays simple enough for others to read and build on. We prioritize:

- **Simplicity**: Clear, maintainable code over clever solutions
- **Extensibility**: Make it easy for others to fork and customize
- **Privacy**: Keep everything local and offline
- **Accessibility**: Free tooling that belongs in everyone's hands

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager
- Platform-specific build tools (see [BUILD.md](BUILD.md))

### Setting Up Your Development Environment

1. **Fork the repository**

2. **Clone your fork**:

   ```bash
   git clone <your-fork-url> elchi
   cd elchi
   ```

3. **Add the upstream remote** (this repository):

   ```bash
   git remote add upstream <repository-url>
   ```

4. **Install dependencies**:

   ```bash
   bun install
   ```

5. **Download the VAD model**:

   ```bash
   mkdir -p src-tauri/resources/models
   curl -L -o src-tauri/resources/models/silero-vad-v6.2-F32.gguf https://huggingface.co/handy-computer/silero-vad-v6.2-gguf/resolve/main/silero-vad-v6.2-F32.gguf
   ```

6. **Run in development mode**:
   ```bash
   bun run tauri dev
   # On macOS if you encounter cmake errors:
   CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
   ```

For detailed platform-specific setup instructions, see [BUILD.md](BUILD.md).

### Understanding the Codebase

The code is split into a Rust backend and a React frontend:

**Backend (Rust - `src-tauri/src/`):**

- `lib.rs` - Main application entry point with Tauri setup
- `managers/` - Core business logic (audio, model, transcription)
- `audio_toolkit/` - Low-level audio processing (recording, VAD)
- `commands/` - Tauri command handlers for frontend communication
- `shortcut/` - Global keyboard shortcut handling
- `settings.rs` - Application settings management

**Frontend (React/TypeScript - `src/`):**

- `App.tsx` - Main application component
- `components/` - React UI components
- `hooks/` - Reusable React hooks
- `lib/types/` - Shared TypeScript types

For more details, see [AGENTS.md](AGENTS.md).

## Reporting Bugs

### Before Submitting a Bug Report

1. **Search existing issues** in this repository, including closed ones
2. **Try the latest version** to see if the issue has been fixed
3. **Enable debug mode** (`Cmd/Ctrl+Shift+D`) to gather diagnostic information

### Submitting a Bug Report

When creating a bug report, please include:

**System Information:**

- App version (found in settings or about section)
- Operating System (e.g., macOS 14.1, Windows 11, Ubuntu 22.04)
- CPU (e.g., Apple M2, Intel i7-12700K, AMD Ryzen 7 5800X)
- GPU (e.g., Apple M2 GPU, NVIDIA RTX 4080, Intel UHD Graphics)

**Bug Details:**

- Clear description of the bug
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots or logs if applicable
- Information from debug mode if relevant

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) when creating an issue.

## Suggesting Features

To suggest a feature, first search the existing issues in this repository. If nothing matches, open an issue in this repository and describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered
- How it fits with the philosophy above

## Making Code Contributions

### Before You Start

Before writing any code, please do the following:

1. **Search existing issues and PRs** - Check both open and closed issues and pull requests in this repository. Someone may have already addressed this, or there may be a reason it was closed.

2. **If something was previously closed** - If you want to revisit a closed issue or PR, you need to:
   - Provide a strong argument for why it should be reconsidered
   - Discuss it first in an issue in this repository
   - Link to that issue in your PR

3. **Talk about features before building them** - Open an issue describing the feature before writing a large change, and link to it in your PR. This keeps Eshlik focused and saves you from work that may not be merged.

### Development Workflow

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes**:
   - Write clean, maintainable code
   - Follow existing code style and patterns
   - Add comments for complex logic
   - Keep commits focused and atomic

3. **Test thoroughly**:
   - Test on your target platform(s)
   - Verify existing functionality still works
   - Test edge cases and error conditions
   - Use debug mode to verify audio/transcription behavior

4. **Commit your changes**:

   ```bash
   git add .
   git commit -m "feat: add your feature description"
   # or
   git commit -m "fix: describe the bug fix"
   ```

   Use conventional commit messages:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation changes
   - `refactor:` for code refactoring
   - `test:` for test additions/changes
   - `chore:` for maintenance tasks

5. **Keep your fork updated**:

   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

6. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request**:
   - Open a pull request against this repository
   - Select your fork and branch
   - Fill out the PR template completely, including:
     - Clear description of changes
     - Links to related issues
     - How you tested the changes
     - Screenshots/videos if applicable
     - Breaking changes (if any)

### AI Assistance Disclosure

AI-assisted PRs are welcome. Use whatever tools help you contribute, and be upfront about it.

In your PR description, please include:

- Whether AI was used (yes/no)
- Which tools were used (e.g., "Claude Code", "GitHub Copilot", "ChatGPT")
- How extensively it was used (e.g., "generated boilerplate", "helped debug", "wrote most of the code")

### Code Style Guidelines

**Rust:**

- Follow standard Rust formatting (`cargo fmt`)
- Run `cargo clippy` and address warnings
- Use descriptive variable and function names
- Add doc comments for public APIs
- Handle errors explicitly (avoid unwrap in production code)

**TypeScript/React:**

- Use TypeScript strictly, avoid `any` types
- Follow React hooks best practices
- Use functional components
- Keep components small and focused
- Use Tailwind CSS for styling

**General:**

- Write self-documenting code
- Add comments for non-obvious logic
- Keep functions small and single-purpose
- Prioritize readability over cleverness

### Testing Your Changes

**Manual Testing:**

- Run the app in development mode: `bun run tauri dev`
- Test your changes with debug mode enabled
- Verify on multiple platforms if possible
- Test with different audio devices
- Try various transcription scenarios

**Building for Production:**

```bash
bun run tauri build
```

Test the production build to ensure it works as expected.

## Documentation Contributions

Documentation improvements are welcome. You can contribute by:

- Improving README.md, BUILD.md, or this CONTRIBUTING.md
- Adding code comments and doc comments
- Creating tutorials or guides
- Improving error messages
- Improving translations (see [CONTRIBUTING_TRANSLATIONS.md](CONTRIBUTING_TRANSLATIONS.md))

## Community Guidelines

- **Be respectful and inclusive** - We welcome contributors of all skill levels
- **Be patient** - This is maintained by a small team, responses may take time
- **Be constructive** - Focus on solutions and improvements
- **Be collaborative** - Help others and share knowledge
- **Search first** - Check existing issues before creating new ones

## Good First Issues

Look for issues labeled `good first issue` or `help wanted` if you're new to the project. These are typically:

- Well-defined and scoped
- Good for learning the codebase

## Getting Help

If you are stuck, open an issue in this repository and describe what you tried.

## License

By contributing to Eshlik, you agree that your contributions will be licensed under the MIT License. See [LICENSE](LICENSE) for details.
