# Contributing to next-limitr

We love your input! We want to make contributing to next-limitr as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features
- Becoming a maintainer

## We Develop with Github

We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

## We Use [Github Flow](https://guides.github.com/introduction/flow/index.html)

Pull requests are the best way to propose changes to the codebase. We actively welcome your pull requests:

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Ensure the test suite passes.
5. Make sure your code lints.
6. Issue that pull request!

## Development Workflow

### Setup

```bash
# Clone the repository
git clone https://github.com/KingIronMan2011/next-limitr.git
cd next-limitr

# Install dependencies
npm install

# Build the project
npm run build
```

### Available Scripts

- `npm run build` - Build the TypeScript code
- `npm run build:clean` - Clean and build
- `npm run clean` - Remove the dist directory
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Run ESLint and fix issues
- `npm run types` - Check TypeScript types
- `npm test` - Run tests with Vitest

### Before Submitting a Pull Request

Make sure your code passes all checks:

```bash
# Check formatting
npm run format:check

# Lint your code
npm run lint

# Run tests
npm test

# Build the project
npm run build
```

All of these checks will run automatically in CI when you submit a pull request.

## Continuous Integration

This project uses GitHub Actions for CI/CD:

### CI Workflow (`.github/workflows/ci.yml`)

Runs on every push and pull request to `main`:
- **Prettier Check**: Ensures code formatting is consistent
- **ESLint**: Checks for code quality issues
- **Tests**: Runs the full test suite
- **Build**: Verifies the project builds successfully

### Publish Workflow (`.github/workflows/npm-publish.yml`)

Runs on push to `main` and can be triggered manually:
- **Version Check**: Verifies if the current version is already published
- **npm Publish**: Publishes to npm using trusted publishing (provenance)
- **GitHub Packages**: Publishes to GitHub Packages
- **Release Creation**: Creates a Git tag and GitHub release

**Note**: The publish workflow automatically skips publishing if the version already exists, preventing accidental duplicate releases.

## Any contributions you make will be under the MIT Software License

In short, when you submit code changes, your submissions are understood to be under the same [MIT License](http://choosealicense.com/licenses/mit/) that covers the project. Feel free to contact the maintainers if that's a concern.

## Report bugs using Github's [issue tracker](https://github.com/KingIronMan2011/next-limitr/issues)

We use GitHub issues to track public bugs. Report a bug by [opening a new issue](https://github.com/KingIronMan2011/next-limitr/issues/new); it's that easy!

## Write bug reports with detail, background, and sample code

**Great Bug Reports** tend to have:

- A quick summary and/or background
- Steps to reproduce
  - Be specific!
  - Give sample code if you can.
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening, or stuff you tried that didn't work)

## Use a Consistent Coding Style

- Use TypeScript for all code files
- 2 spaces for indentation rather than tabs
- You can try running `npm run lint` for style unification

## License

By contributing, you agree that your contributions will be licensed under its MIT License.
