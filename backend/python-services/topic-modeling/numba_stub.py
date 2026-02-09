"""
Stub pour numba - permet à UMAP de s'importer sans numba
UMAP peut fonctionner sans numba, juste plus lentement
"""

# Fonction no-op pour jit
def jit(*args, **kwargs):
    """Decorator stub for numba.jit - returns function unchanged"""
    def decorator(func):
        return func
    if len(args) == 1 and callable(args[0]):
        return args[0]
    return decorator

# Alias
njit = jit
vectorize = jit
prange = range  # Remplacer prange par range normal

# Types stub class
class _TypeStub:
    """Stub for numba types - callable pour supporter Array(...) et autres"""
    def __call__(self, *args, **kwargs):
        return self  # Retourne self pour chainage

    def __getattr__(self, name):
        return self  # Retourne self pour chainage

    def __getitem__(self, key):
        return self  # Support pour indexing types.int32[:] etc.

# Module types stub avec métaclasse pour __getattr__ statique
class _TypesMeta(type):
    """Métaclasse pour permettre __getattr__ sur la classe types"""
    def __getattr__(cls, name):
        return _TypeStub()

class types(metaclass=_TypesMeta):
    """Stub pour numba.types"""
    int32 = _TypeStub()
    int64 = _TypeStub()
    intp = _TypeStub()  # Pointeur entier natif
    float32 = _TypeStub()
    float64 = _TypeStub()
    boolean = _TypeStub()
    void = _TypeStub()
    uint8 = _TypeStub()
    uint16 = _TypeStub()
    uint32 = _TypeStub()
    uint64 = _TypeStub()
    complex64 = _TypeStub()
    complex128 = _TypeStub()

    @staticmethod
    def Array(*args, **kwargs):
        """Stub pour types.Array"""
        return _TypeStub()

# Module pour config
class config:
    THREADING_LAYER = 'workqueue'
    NUMBA_NUM_THREADS = 1
    DISABLE_JIT = True

# Errors stubs
class NumbaError(Exception):
    pass

class TypingError(NumbaError):
    pass

# Module extending pour pynndescent
class extending:
    """Stub pour numba.extending"""
    @staticmethod
    def intrinsic(*args, **kwargs):
        """Stub pour intrinsic decorator"""
        def decorator(func):
            return func
        if len(args) == 1 and callable(args[0]):
            return args[0]
        return decorator

    @staticmethod
    def overload(*args, **kwargs):
        """Stub pour overload decorator"""
        def decorator(func):
            return func
        if len(args) == 1 and callable(args[0]):
            return args[0]
        return decorator

    @staticmethod
    def overload_method(*args, **kwargs):
        """Stub pour overload_method decorator"""
        def decorator(func):
            return func
        if len(args) == 1 and callable(args[0]):
            return args[0]
        return decorator

# Permettre d'autres imports
def __getattr__(name):
    """Catch-all pour autres attributs"""
    return _TypeStub()
