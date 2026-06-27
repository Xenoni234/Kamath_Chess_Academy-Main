import Link from "next/link";
import Image from "next/image";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-kca-black border-t border-kca-border px-6 py-12 md:px-8 md:py-16">
      <div className="mx-auto max-w-7xl">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 md:grid-cols-4">
          
          {/* Column 1: Logo & Tagline */}
          <div className="space-y-4">
            <Link href="/#home" className="flex items-center gap-3">
              <Image
                src="/kca-logo.png"
                alt="Kamath Chess Academy Logo"
                width={36}
                height={36}
                className="h-9 w-auto"
              />
              <span className="font-display text-lg font-bold tracking-tight text-kca-white">
                KCA PLATFORM
              </span>
            </Link>
            <p className="font-sans text-sm text-kca-gray-400 leading-relaxed max-w-xs">
              Empowering chess minds worldwide through Soviet-Russian training methodologies and modern AI analytical engines.
            </p>
          </div>

          {/* Column 2: Quick Links */}
          <div>
            <h4 className="font-display text-sm font-bold uppercase tracking-wider text-kca-white mb-4">
              Quick Links
            </h4>
            <ul className="space-y-2">
              <li>
                <Link href="/#home" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Home
                </Link>
              </li>
              <li>
                <Link href="/#achievements" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Achievements
                </Link>
              </li>
              <li>
                <Link href="/#schedule" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Tournaments
                </Link>
              </li>
              <li>
                <Link href="/#about" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  About Us
                </Link>
              </li>
              <li>
                <Link href="/#contact" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Contact Us
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 3: Legal links */}
          <div>
            <h4 className="font-display text-sm font-bold uppercase tracking-wider text-kca-white mb-4">
              Legal Links
            </h4>
            <ul className="space-y-2">
              <li>
                <Link href="#" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="#" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link href="#" className="font-sans text-sm text-kca-gray-400 hover:text-kca-cyan transition-colors">
                  Refund Policy
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 4: Contact Info */}
          <div>
            <h4 className="font-display text-sm font-bold uppercase tracking-wider text-kca-white mb-4">
              Contact Info
            </h4>
            <ul className="space-y-2 font-sans text-sm text-kca-gray-400">
              <li>
                Email: <span className="text-kca-white">kamathchessacademy@gmail.com</span>
              </li>
              <li>
                Phone: <span className="text-kca-white">9175067715, +91 73874 65229</span>
              </li>
              <li className="leading-relaxed">
                Address: <span className="text-kca-white">Mumbai, India</span>
              </li>
            </ul>
          </div>

        </div>

        {/* Bottom copyright bar */}
        <div className="mt-12 pt-8 border-t border-kca-border/40 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="font-sans text-xs text-kca-gray-600">
            &copy; {currentYear} Kamath Chess Academy. All rights reserved.
          </p>
          <p className="font-sans text-xs text-kca-gray-600">
            Designed & built with precision for elite performance.
          </p>
        </div>
      </div>
    </footer>
  );
}
