"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

interface AuthContextType {
  user: { username: string } | null
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
}

const AuthContext = React.createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<{ username: string } | null>(null)
  const router = useRouter()

  React.useEffect(() => {
    const stored = document.cookie
      .split("; ")
      .find((row) => row.startsWith("user="))
      ?.split("=")[1]

    if (stored) {
      try {
        setUser(JSON.parse(decodeURIComponent(stored)))
      } catch {
        setUser(null)
      }
    }
  }, [])

  const login = async (username: string, password: string): Promise<boolean> => {
    if (username && password) {
      const userData = { username }
      setUser(userData)
      document.cookie = `user=${encodeURIComponent(JSON.stringify(userData))}; path=/; max-age=${60 * 60 * 24 * 7}`
      return true
    }
    return false
  }

  const logout = () => {
    setUser(null)
    document.cookie = "user=; path=/; max-age=0"
    router.push("/login")
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = React.useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
